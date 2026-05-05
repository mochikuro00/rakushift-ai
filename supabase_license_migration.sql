-- =========================================================
-- Rakushift AI: マルチテナント ライセンス管理マイグレーション
-- - organizations テーブルにライセンス管理カラム追加
-- - platform_admins テーブル (運営管理者)
-- - ライセンス管理用RPC関数群
-- =========================================================

-- 0. 拡張機能
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- =========================================================
-- 1. organizations テーブルにライセンス管理カラム追加
-- =========================================================
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS license_status TEXT DEFAULT 'active'
    CHECK (license_status IN ('active', 'suspended'));

-- ライセンス停止日時 (NULLならアクティブ)
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS license_suspended_at TIMESTAMPTZ;

-- データ削除予定日 (停止から6ヶ月後に自動設定)
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS data_deletion_scheduled_at TIMESTAMPTZ;

-- ライセンスに関するメモ（運営用）
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS license_note TEXT DEFAULT '';

-- =========================================================
-- 2. 運営管理者テーブル
-- =========================================================
CREATE TABLE IF NOT EXISTS platform_admins (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    login_id TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,  -- bcryptハッシュ
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- RLS有効化: 直接アクセス不可（RPC経由のみ）
ALTER TABLE platform_admins ENABLE ROW LEVEL SECURITY;
CREATE POLICY "platform_admins_no_direct_access" ON platform_admins
    FOR ALL TO anon USING (false);

-- =========================================================
-- 3. 初期運営管理者アカウント作成
-- =========================================================
-- デフォルト: login_id = 'admin', password = 'rakushift2024'
INSERT INTO platform_admins (login_id, password, name)
VALUES (
    'admin',
    crypt('rakushift2024', gen_salt('bf')),
    'システム管理者'
) ON CONFLICT (login_id) DO NOTHING;

-- =========================================================
-- 4. 運営管理者ログイン検証関数
-- =========================================================
CREATE OR REPLACE FUNCTION verify_platform_admin_login(
    p_login_id TEXT,
    p_password TEXT
) RETURNS JSONB AS $$
DECLARE
    v_admin RECORD;
BEGIN
    SELECT id, login_id, name, password AS pw_hash
    INTO v_admin
    FROM platform_admins
    WHERE login_id = p_login_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'message', 'ログインIDが見つかりません');
    END IF;

    IF v_admin.pw_hash != crypt(p_password, v_admin.pw_hash) THEN
        RETURN jsonb_build_object('success', false, 'message', 'パスワードが正しくありません');
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'admin_id', v_admin.id,
        'name', v_admin.name
    );
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'message', SQLERRM);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =========================================================
-- 5. テナント一覧取得関数 (運営管理者用)
-- =========================================================
CREATE OR REPLACE FUNCTION list_tenants()
RETURNS JSONB AS $$
BEGIN
    RETURN (
        SELECT jsonb_agg(
            jsonb_build_object(
                'organization_id', o.id,
                'name', o.name,
                'contract_id', c.contract_id,
                'license_status', COALESCE(o.license_status, 'active'),
                'license_suspended_at', o.license_suspended_at,
                'data_deletion_scheduled_at', o.data_deletion_scheduled_at,
                'license_note', COALESCE(o.license_note, ''),
                'subscription_status', c.subscription_status,
                'staff_count', (SELECT COUNT(*) FROM staff s WHERE s.organization_id = o.id),
                'created_at', o.created_at
            )
        )
        FROM organizations o
        LEFT JOIN config c ON c.organization_id = o.id
        ORDER BY o.created_at DESC
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =========================================================
-- 6. ライセンス停止関数 (運営管理者用)
-- =========================================================
CREATE OR REPLACE FUNCTION suspend_license(
    p_organization_id UUID,
    p_note TEXT DEFAULT ''
) RETURNS JSONB AS $$
DECLARE
    v_org RECORD;
BEGIN
    SELECT id, name, license_status INTO v_org
    FROM organizations WHERE id = p_organization_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'message', '組織が見つかりません');
    END IF;

    IF v_org.license_status = 'suspended' THEN
        RETURN jsonb_build_object('success', false, 'message', '既にライセンスは停止中です');
    END IF;

    UPDATE organizations SET
        license_status = 'suspended',
        license_suspended_at = now(),
        data_deletion_scheduled_at = now() + INTERVAL '6 months',
        license_note = p_note
    WHERE id = p_organization_id;

    RETURN jsonb_build_object(
        'success', true,
        'message', v_org.name || ' のライセンスを停止しました。データは6ヶ月間保持されます。',
        'data_deletion_scheduled_at', (now() + INTERVAL '6 months')
    );
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'message', SQLERRM);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =========================================================
-- 7. ライセンス復活関数 (運営管理者用)
-- =========================================================
CREATE OR REPLACE FUNCTION activate_license(
    p_organization_id UUID,
    p_note TEXT DEFAULT ''
) RETURNS JSONB AS $$
DECLARE
    v_org RECORD;
BEGIN
    SELECT id, name, license_status, data_deletion_scheduled_at INTO v_org
    FROM organizations WHERE id = p_organization_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'message', '組織が見つかりません');
    END IF;

    IF v_org.license_status = 'active' THEN
        RETURN jsonb_build_object('success', false, 'message', '既にライセンスは有効です');
    END IF;

    -- データ削除予定日を過ぎている場合は警告
    IF v_org.data_deletion_scheduled_at IS NOT NULL AND v_org.data_deletion_scheduled_at < now() THEN
        -- 削除予定を過ぎていても復活は可能（実際の削除は別途バッチ処理）
        NULL;
    END IF;

    UPDATE organizations SET
        license_status = 'active',
        license_suspended_at = NULL,
        data_deletion_scheduled_at = NULL,
        license_note = p_note
    WHERE id = p_organization_id;

    RETURN jsonb_build_object(
        'success', true,
        'message', v_org.name || ' のライセンスを復活しました。'
    );
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'message', SQLERRM);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =========================================================
-- 8. ライセンス状態チェック関数 (テナントログイン時に使用)
-- =========================================================
CREATE OR REPLACE FUNCTION check_license_status(p_contract_id TEXT)
RETURNS JSONB AS $$
DECLARE
    v_org RECORD;
BEGIN
    SELECT o.id, o.name, o.license_status, o.license_suspended_at, o.data_deletion_scheduled_at
    INTO v_org
    FROM organizations o
    JOIN config c ON c.organization_id = o.id
    WHERE c.contract_id = p_contract_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('allowed', false, 'status', 'not_found', 'message', '契約が見つかりません');
    END IF;

    IF COALESCE(v_org.license_status, 'active') = 'active' THEN
        RETURN jsonb_build_object('allowed', true, 'status', 'active');
    ELSE
        RETURN jsonb_build_object(
            'allowed', false,
            'status', 'suspended',
            'message', 'ご契約のライセンスは現在停止中です。ご利用を再開される場合は運営までお問い合わせください。',
            'suspended_at', v_org.license_suspended_at,
            'data_deletion_scheduled_at', v_org.data_deletion_scheduled_at
        );
    END IF;
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('allowed', false, 'status', 'error', 'message', SQLERRM);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =========================================================
-- 9. 運営管理者パスワード変更関数
-- =========================================================
CREATE OR REPLACE FUNCTION update_platform_admin_password(
    p_admin_id UUID,
    p_old_password TEXT,
    p_new_password TEXT
) RETURNS JSONB AS $$
DECLARE
    v_admin RECORD;
    new_hash TEXT;
BEGIN
    SELECT id, password AS pw_hash INTO v_admin
    FROM platform_admins WHERE id = p_admin_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'message', '管理者が見つかりません');
    END IF;

    IF v_admin.pw_hash != crypt(p_old_password, v_admin.pw_hash) THEN
        RETURN jsonb_build_object('success', false, 'message', '現在のパスワードが正しくありません');
    END IF;

    new_hash := crypt(p_new_password, gen_salt('bf'));
    UPDATE platform_admins SET password = new_hash WHERE id = p_admin_id;

    RETURN jsonb_build_object('success', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =========================================================
-- 10. データ削除期限切れテナント一覧取得（バッチ処理用）
-- =========================================================
CREATE OR REPLACE FUNCTION list_expired_tenants()
RETURNS JSONB AS $$
BEGIN
    RETURN (
        SELECT COALESCE(jsonb_agg(
            jsonb_build_object(
                'organization_id', o.id,
                'name', o.name,
                'contract_id', c.contract_id,
                'license_suspended_at', o.license_suspended_at,
                'data_deletion_scheduled_at', o.data_deletion_scheduled_at
            )
        ), '[]'::jsonb)
        FROM organizations o
        LEFT JOIN config c ON c.organization_id = o.id
        WHERE o.license_status = 'suspended'
          AND o.data_deletion_scheduled_at < now()
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =========================================================
-- 11. テナントデータ完全削除関数（運営管理者用・慎重に使用）
-- =========================================================
CREATE OR REPLACE FUNCTION delete_tenant_data(
    p_organization_id UUID
) RETURNS JSONB AS $$
DECLARE
    v_org RECORD;
    v_staff_count INTEGER;
    v_shift_count INTEGER;
    v_request_count INTEGER;
BEGIN
    SELECT id, name, license_status INTO v_org
    FROM organizations WHERE id = p_organization_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'message', '組織が見つかりません');
    END IF;

    -- 安全チェック: アクティブなライセンスのデータは削除不可
    IF v_org.license_status = 'active' THEN
        RETURN jsonb_build_object('success', false, 'message', 'アクティブなライセンスのデータは削除できません。先にライセンスを停止してください。');
    END IF;

    -- 削除件数を記録
    SELECT COUNT(*) INTO v_staff_count FROM staff WHERE organization_id = p_organization_id;
    SELECT COUNT(*) INTO v_shift_count FROM shifts WHERE organization_id = p_organization_id;
    SELECT COUNT(*) INTO v_request_count FROM requests WHERE organization_id = p_organization_id;

    -- CASCADE削除 (organizations削除で関連データも消える)
    DELETE FROM organizations WHERE id = p_organization_id;

    RETURN jsonb_build_object(
        'success', true,
        'message', v_org.name || ' のデータを完全に削除しました。',
        'deleted', jsonb_build_object(
            'staff', v_staff_count,
            'shifts', v_shift_count,
            'requests', v_request_count
        )
    );
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'message', SQLERRM);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =========================================================
-- 12. create_tenant関数を更新 (契約ID自動生成 + 一律パスワード)
-- =========================================================
-- 旧シグネチャの関数を削除してから再作成
DROP FUNCTION IF EXISTS create_tenant(TEXT, TEXT, TEXT);
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

    -- パスワードは一律固定値をbcryptハッシュ化
    hashed_shop_pw := crypt('rakushift1234', gen_salt('bf'));
    hashed_admin_pw := crypt('rakushift1234', gen_salt('bf'));

    -- 1. 組織作成
    INSERT INTO organizations (name) VALUES (p_org_name) RETURNING id INTO new_org_id;

    -- 2. 設定(Config)作成
    INSERT INTO config (
        organization_id, contract_id, shop_password, subscription_status
    ) VALUES (
        new_org_id, v_contract_id, hashed_shop_pw, 'active'
    );

    -- 3. 初期管理者アカウント作成
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
        'organization_id', new_org_id
    );

EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('status', 'error', 'message', SQLERRM);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =========================================================
-- 13. config_safe ビューにライセンス情報を追加
-- =========================================================
CREATE OR REPLACE VIEW config_safe AS
SELECT
    c.id,
    c.organization_id,
    c.contract_id,
    c.stripe_customer_id,
    c.stripe_subscription_id,
    c.subscription_status,
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

-- 権限再設定
GRANT SELECT ON config_safe TO anon;

-- =========================================================
-- 13. スキーマリロード通知
-- =========================================================
NOTIFY pgrst, 'reload schema';
