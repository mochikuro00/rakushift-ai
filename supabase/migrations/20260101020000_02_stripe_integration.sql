-- =========================================================
-- Rakushift AI: Stripe SaaS決済連携マイグレーション
-- - サブスクリプション状態管理の強化
-- - Stripe顧客・サブスクリプション紐付けRPC関数
-- - 課金プラン管理
-- =========================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- =========================================================
-- 1. config テーブルにプラン情報カラム追加
-- =========================================================
ALTER TABLE config ADD COLUMN IF NOT EXISTS stripe_plan TEXT DEFAULT 'free';
-- stripe_plan: 'free', 'standard', 'pro', 'premium'

ALTER TABLE config ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ;
-- 無料トライアル終了日

ALTER TABLE config ADD COLUMN IF NOT EXISTS subscription_current_period_end TIMESTAMPTZ;
-- 現在の課金期間終了日

-- subscription_status に新しい値を許容するためCHECK制約は追加しない
-- (Stripeから多様なステータスが来るため: active, trialing, past_due, canceled, unpaid, incomplete)

-- =========================================================
-- 2. サブスクリプション状態更新関数 (Webhook用)
-- =========================================================
CREATE OR REPLACE FUNCTION update_subscription_status(
    p_contract_id TEXT,
    p_status TEXT,
    p_subscription_id TEXT DEFAULT NULL,
    p_customer_id TEXT DEFAULT NULL,
    p_plan TEXT DEFAULT NULL,
    p_period_end TIMESTAMPTZ DEFAULT NULL
) RETURNS JSONB AS $$
BEGIN
    UPDATE config SET
        subscription_status = COALESCE(p_status, subscription_status),
        stripe_subscription_id = COALESCE(p_subscription_id, stripe_subscription_id),
        stripe_customer_id = COALESCE(p_customer_id, stripe_customer_id),
        stripe_plan = COALESCE(p_plan, stripe_plan),
        subscription_current_period_end = COALESCE(p_period_end, subscription_current_period_end)
    WHERE contract_id = p_contract_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'message', 'Contract not found');
    END IF;

    RETURN jsonb_build_object('success', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =========================================================
-- 3. サブスクリプション状態チェック関数 (ログイン時・操作時)
-- =========================================================
-- 既存のcheck_subscription_statusを拡張
CREATE OR REPLACE FUNCTION check_subscription_status(p_contract_id TEXT)
RETURNS JSONB AS $$
DECLARE
    v_config RECORD;
BEGIN
    SELECT
        c.subscription_status,
        c.stripe_plan,
        c.stripe_subscription_id,
        c.trial_ends_at,
        c.subscription_current_period_end,
        o.license_status,
        o.license_suspended_at
    INTO v_config
    FROM config c
    LEFT JOIN organizations o ON o.id = c.organization_id
    WHERE c.contract_id = p_contract_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object(
            'allowed', false,
            'status', 'not_found',
            'message', 'Contract not found'
        );
    END IF;

    -- ライセンス停止チェック (運営による強制停止)
    IF COALESCE(v_config.license_status, 'active') = 'suspended' THEN
        RETURN jsonb_build_object(
            'allowed', false,
            'status', 'suspended',
            'message', 'ライセンスが停止されています。運営までお問い合わせください。',
            'suspended_at', v_config.license_suspended_at
        );
    END IF;

    -- トライアル期間中
    IF v_config.trial_ends_at IS NOT NULL AND v_config.trial_ends_at > now() THEN
        RETURN jsonb_build_object(
            'allowed', true,
            'status', 'trialing',
            'plan', COALESCE(v_config.stripe_plan, 'free'),
            'trial_ends_at', v_config.trial_ends_at
        );
    END IF;

    -- サブスクリプション状態チェック
    IF v_config.subscription_status IN ('active', 'trialing') THEN
        RETURN jsonb_build_object(
            'allowed', true,
            'status', v_config.subscription_status,
            'plan', COALESCE(v_config.stripe_plan, 'free'),
            'period_end', v_config.subscription_current_period_end
        );
    ELSIF v_config.subscription_status = 'past_due' THEN
        -- 支払い遅延: まだ使えるが警告
        RETURN jsonb_build_object(
            'allowed', true,
            'status', 'past_due',
            'plan', COALESCE(v_config.stripe_plan, 'free'),
            'message', 'お支払いが確認できていません。お支払い方法を更新してください。'
        );
    ELSIF v_config.subscription_status IN ('canceled', 'unpaid') THEN
        RETURN jsonb_build_object(
            'allowed', false,
            'status', v_config.subscription_status,
            'message', 'サブスクリプションが無効です。プランを再度ご契約ください。'
        );
    END IF;

    -- デフォルト: free プランは常に許可 (Stripe未契約)
    IF COALESCE(v_config.stripe_plan, 'free') = 'free' AND v_config.stripe_subscription_id IS NULL THEN
        RETURN jsonb_build_object(
            'allowed', true,
            'status', 'free',
            'plan', 'free',
            'message', '無料プランをご利用中です。'
        );
    END IF;

    -- その他
    RETURN jsonb_build_object(
        'allowed', true,
        'status', COALESCE(v_config.subscription_status, 'active'),
        'plan', COALESCE(v_config.stripe_plan, 'free')
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =========================================================
-- 4. テナント作成時にトライアル期間を設定
-- =========================================================
DROP FUNCTION IF EXISTS create_tenant(TEXT);

CREATE OR REPLACE FUNCTION create_tenant(
    p_org_name TEXT
) RETURNS JSONB AS $$
DECLARE
    new_org_id UUID;
    v_contract_id TEXT;
    hashed_shop_pw TEXT;
    hashed_admin_pw TEXT;
BEGIN
    -- 契約IDを15桁ランダム数字で自動生成
    LOOP
        v_contract_id := lpad(floor(random() * 1e15)::bigint::text, 15, '0');
        EXIT WHEN NOT EXISTS (SELECT 1 FROM config WHERE contract_id = v_contract_id);
    END LOOP;

    hashed_shop_pw := crypt('rakushift1234', gen_salt('bf'));
    hashed_admin_pw := crypt('rakushift1234', gen_salt('bf'));

    -- 1. 組織作成
    INSERT INTO organizations (name) VALUES (p_org_name) RETURNING id INTO new_org_id;

    -- 2. 設定作成 (14日間の無料トライアル付き)
    INSERT INTO config (
        organization_id, contract_id, shop_password,
        subscription_status, stripe_plan, trial_ends_at
    ) VALUES (
        new_org_id, v_contract_id, hashed_shop_pw,
        'trialing', 'standard', now() + INTERVAL '14 days'
    );

    -- 3. 初期管理者
    INSERT INTO staff (
        organization_id, contract_id, login_id, password,
        name, role, evaluation, salary_type, monthly_salary
    ) VALUES (
        new_org_id, v_contract_id, 'admin', hashed_admin_pw,
        '管理者 (初期アカウント)', 'manager', 'A', 'monthly', 300000
    );

    RETURN jsonb_build_object(
        'status', 'success',
        'contract_id', v_contract_id,
        'organization_id', new_org_id,
        'trial_ends_at', (now() + INTERVAL '14 days')
    );

EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('status', 'error', 'message', SQLERRM);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =========================================================
-- 5. config_safe ビューにプラン情報追加
-- =========================================================
-- 列が増えるため CREATE OR REPLACE では置き換えられない
-- (ERROR: cannot change name of view column ...)。作り直す。
DROP VIEW IF EXISTS config_safe;
CREATE OR REPLACE VIEW config_safe AS
SELECT
    c.id,
    c.organization_id,
    c.contract_id,
    c.stripe_customer_id,
    c.stripe_subscription_id,
    c.subscription_status,
    c.stripe_plan,
    c.trial_ends_at,
    c.subscription_current_period_end,
    c.opening_time,
    c.closing_time,
    c.hourly_wage_default,
    c.opening_times,
    c.closed_days,
    c.staff_req,
    c.roles,
    c.special_holidays,
    c.special_days,
    c.time_staff_req,
    c.calendar_notes,
    c.break_rules,
    c.shop_rules_text,
    c.custom_shifts,
    c.openai_model,
    c.gemini_model,
    c.llm_provider,
    o.license_status,
    o.license_suspended_at
FROM config c
LEFT JOIN organizations o ON o.id = c.organization_id;

GRANT SELECT ON config_safe TO anon;

-- =========================================================
-- 6. スキーマリロード
-- =========================================================
NOTIFY pgrst, 'reload schema';
