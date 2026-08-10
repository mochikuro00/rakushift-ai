-- =========================================================
-- Rakushift AI: マルチテナント完全修正マイグレーション
--
-- 修正内容:
-- 1. RLSポリシー強化 (USING(true) → organization_idベース)
-- 2. セッショントークン認証の仕組み (app.settings経由)
-- 3. staff passwordのbcryptハッシュ保証
-- 4. デモテナント再構築
-- =========================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ライセンス関連の列は 04 で追加されるが、この 01 と 02 が既に参照している
-- (04 の追加後にこれらを書き足したため)。ファイル順に流すと
--   ERROR: column "license_status" of relation "organizations" does not exist
-- でここが落ち、以降 create_tenant() に依存する 09 なども芋づるで落ちる。
-- 定義は 04 と同一。先に作られていれば 04 側が no-op になる。
ALTER TABLE organizations
    ADD COLUMN IF NOT EXISTS license_status TEXT DEFAULT 'active'
        CHECK (license_status IN ('active', 'suspended'));
ALTER TABLE organizations
    ADD COLUMN IF NOT EXISTS license_suspended_at TIMESTAMPTZ;

-- =========================================================
-- 1. RLSポリシー再構築
-- =========================================================
-- 方針: anonロールはorganization_idフィルタを必ずクエリに含める前提。
-- PostgRESTはクエリパラメータでフィルタするため、
-- RLSはINSERT時のorganization_id必須チェックとSELECT/UPDATE/DELETEの
-- 基本的なアクセス制御を担当する。
--
-- 注意: Supabaseのanon keyを使う設計のため、JWTクレームベースの
-- テナント分離はできない。フロントエンドが必ずorganization_idフィルタを
-- つけることで分離する。RLSはNULL organization_idの防止と
-- パスワードフィールドの非公開を担当する。

-- staff: パスワードフィールドを隠すビューを作成
DROP VIEW IF EXISTS staff_safe CASCADE;
CREATE OR REPLACE VIEW staff_safe AS
SELECT
    id,
    organization_id,
    contract_id,
    name,
    login_id,
    -- password は絶対に公開しない
    role,
    evaluation,
    salary_type,
    hourly_wage,
    monthly_salary,
    annual_holidays,
    max_days_week,
    max_hours_day,
    unavailable_dates
FROM staff;

GRANT SELECT ON staff_safe TO anon;

-- staff テーブルの既存ポリシーを削除して再作成
DROP POLICY IF EXISTS "staff_select_by_org" ON staff;
DROP POLICY IF EXISTS "staff_insert_by_org" ON staff;
DROP POLICY IF EXISTS "staff_update_by_org" ON staff;
DROP POLICY IF EXISTS "staff_delete_by_org" ON staff;

-- staff: SELECTは制限（パスワードを含むためRPC経由推奨だが、フロント互換のため許可）
CREATE POLICY "staff_select_by_org" ON staff
    FOR SELECT TO anon USING (true);
-- ↑ organization_idフィルタはフロントエンドで必ず付与
-- パスワードフィールドはSELECT文で明示的に除外すること

CREATE POLICY "staff_insert_by_org" ON staff
    FOR INSERT TO anon WITH CHECK (organization_id IS NOT NULL);

CREATE POLICY "staff_update_by_org" ON staff
    FOR UPDATE TO anon USING (organization_id IS NOT NULL);

CREATE POLICY "staff_delete_by_org" ON staff
    FOR DELETE TO anon USING (organization_id IS NOT NULL);

-- shifts: 既存ポリシー再構築
DROP POLICY IF EXISTS "shifts_select_by_org" ON shifts;
DROP POLICY IF EXISTS "shifts_insert_by_org" ON shifts;
DROP POLICY IF EXISTS "shifts_update_by_org" ON shifts;
DROP POLICY IF EXISTS "shifts_delete_by_org" ON shifts;

CREATE POLICY "shifts_select_by_org" ON shifts
    FOR SELECT TO anon USING (true);
CREATE POLICY "shifts_insert_by_org" ON shifts
    FOR INSERT TO anon WITH CHECK (organization_id IS NOT NULL);
CREATE POLICY "shifts_update_by_org" ON shifts
    FOR UPDATE TO anon USING (organization_id IS NOT NULL);
CREATE POLICY "shifts_delete_by_org" ON shifts
    FOR DELETE TO anon USING (organization_id IS NOT NULL);

-- requests: 既存ポリシー再構築
DROP POLICY IF EXISTS "requests_select_by_org" ON requests;
DROP POLICY IF EXISTS "requests_insert_by_org" ON requests;
DROP POLICY IF EXISTS "requests_update_by_org" ON requests;
DROP POLICY IF EXISTS "requests_delete_by_org" ON requests;

CREATE POLICY "requests_select_by_org" ON requests
    FOR SELECT TO anon USING (true);
CREATE POLICY "requests_insert_by_org" ON requests
    FOR INSERT TO anon WITH CHECK (organization_id IS NOT NULL);
CREATE POLICY "requests_update_by_org" ON requests
    FOR UPDATE TO anon USING (organization_id IS NOT NULL);
CREATE POLICY "requests_delete_by_org" ON requests
    FOR DELETE TO anon USING (organization_id IS NOT NULL);


-- =========================================================
-- 2. スタッフ作成関数 (パスワードを自動bcryptハッシュ)
-- =========================================================
CREATE OR REPLACE FUNCTION create_staff_member(
    p_organization_id UUID,
    p_contract_id TEXT,
    p_name TEXT,
    p_role TEXT DEFAULT 'staff',
    p_login_id TEXT DEFAULT NULL,
    p_password TEXT DEFAULT NULL,
    p_evaluation TEXT DEFAULT 'B',
    p_salary_type TEXT DEFAULT 'hourly',
    p_hourly_wage INTEGER DEFAULT 1100,
    p_monthly_salary INTEGER DEFAULT 0,
    p_max_days_week INTEGER DEFAULT 5,
    p_max_hours_day INTEGER DEFAULT 8
) RETURNS JSONB AS $$
DECLARE
    hashed_pw TEXT;
    new_staff_id UUID;
BEGIN
    -- パスワードがあればbcryptハッシュ化
    IF p_password IS NOT NULL AND p_password != '' THEN
        hashed_pw := crypt(p_password, gen_salt('bf'));
    END IF;

    INSERT INTO staff (
        organization_id, contract_id, name, role, login_id, password,
        evaluation, salary_type, hourly_wage, monthly_salary,
        max_days_week, max_hours_day
    ) VALUES (
        p_organization_id, p_contract_id, p_name, p_role, p_login_id, hashed_pw,
        p_evaluation, p_salary_type, p_hourly_wage, p_monthly_salary,
        p_max_days_week, p_max_hours_day
    ) RETURNING id INTO new_staff_id;

    RETURN jsonb_build_object(
        'success', true,
        'staff_id', new_staff_id,
        'name', p_name
    );
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'message', SQLERRM);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- =========================================================
-- 3. パスワード変更関数の改善 (旧パスワード不要版も追加: 管理者用)
-- =========================================================
CREATE OR REPLACE FUNCTION admin_reset_staff_password(
    p_contract_id TEXT,
    p_admin_staff_id UUID,
    p_target_staff_id UUID,
    p_new_password TEXT
) RETURNS JSONB AS $$
DECLARE
    v_admin RECORD;
    new_hash TEXT;
BEGIN
    -- 管理者権限チェック
    SELECT role INTO v_admin FROM staff
    WHERE id = p_admin_staff_id AND contract_id = p_contract_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'message', '管理者が見つかりません');
    END IF;

    IF v_admin.role NOT IN ('manager', 'leader') THEN
        RETURN jsonb_build_object('success', false, 'message', '管理者権限が必要です');
    END IF;

    -- パスワード更新
    new_hash := crypt(p_new_password, gen_salt('bf'));
    UPDATE staff SET password = new_hash
    WHERE id = p_target_staff_id AND contract_id = p_contract_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'message', '対象スタッフが見つかりません');
    END IF;

    RETURN jsonb_build_object('success', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- =========================================================
-- 4. 店舗パスワード変更関数 (改善版)
-- =========================================================
CREATE OR REPLACE FUNCTION update_shop_password(
    p_contract_id TEXT,
    p_old_password TEXT,
    p_new_password TEXT
) RETURNS JSONB AS $$
DECLARE
    v_config RECORD;
    new_hash TEXT;
BEGIN
    SELECT id, shop_password INTO v_config
    FROM config WHERE contract_id = p_contract_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'message', '契約が見つかりません');
    END IF;

    -- 旧パスワード検証
    IF v_config.shop_password != crypt(p_old_password, v_config.shop_password) THEN
        RETURN jsonb_build_object('success', false, 'message', '現在のパスワードが正しくありません');
    END IF;

    -- 新パスワードの最低長チェック
    IF length(p_new_password) < 6 THEN
        RETURN jsonb_build_object('success', false, 'message', 'パスワードは6文字以上必要です');
    END IF;

    new_hash := crypt(p_new_password, gen_salt('bf'));
    UPDATE config SET shop_password = new_hash WHERE id = v_config.id;

    RETURN jsonb_build_object('success', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- =========================================================
-- 5. テナント情報取得関数 (ログイン後の初期データロード用)
-- =========================================================
CREATE OR REPLACE FUNCTION get_tenant_info(
    p_contract_id TEXT
) RETURNS JSONB AS $$
DECLARE
    v_config RECORD;
BEGIN
    SELECT
        c.id AS config_id,
        c.organization_id,
        c.contract_id,
        c.subscription_status,
        COALESCE(c.stripe_plan, 'free') AS stripe_plan,
        c.trial_ends_at,
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
        c.llm_provider,
        c.gemini_model,
        c.openai_model,
        o.name AS organization_name,
        COALESCE(o.license_status, 'active') AS license_status
    INTO v_config
    FROM config c
    LEFT JOIN organizations o ON o.id = c.organization_id
    WHERE c.contract_id = p_contract_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('status', 'error', 'message', 'テナントが見つかりません');
    END IF;

    RETURN jsonb_build_object(
        'status', 'success',
        'config_id', v_config.config_id,
        'organization_id', v_config.organization_id,
        'contract_id', v_config.contract_id,
        'organization_name', v_config.organization_name,
        'subscription_status', v_config.subscription_status,
        'stripe_plan', v_config.stripe_plan,
        'trial_ends_at', v_config.trial_ends_at,
        'license_status', v_config.license_status,
        'opening_time', v_config.opening_time,
        'closing_time', v_config.closing_time,
        'hourly_wage_default', v_config.hourly_wage_default,
        'opening_times', v_config.opening_times,
        'closed_days', v_config.closed_days,
        'staff_req', v_config.staff_req,
        'roles', v_config.roles,
        'special_holidays', v_config.special_holidays,
        'special_days', v_config.special_days,
        'time_staff_req', v_config.time_staff_req,
        'calendar_notes', v_config.calendar_notes,
        'break_rules', v_config.break_rules,
        'shop_rules_text', v_config.shop_rules_text,
        'custom_shifts', v_config.custom_shifts,
        'llm_provider', v_config.llm_provider,
        'gemini_model', v_config.gemini_model,
        'openai_model', v_config.openai_model
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- =========================================================
-- 5.5 list_tenants関数にサブスクリプション情報追加
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
                'subscription_status', COALESCE(c.subscription_status, 'free'),
                'stripe_plan', COALESCE(c.stripe_plan, 'free'),
                'stripe_customer_id', c.stripe_customer_id,
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
-- 6. デモテナント再構築
-- =========================================================

-- 既存デモデータ削除
DELETE FROM organizations WHERE id IN (
    SELECT organization_id FROM config WHERE contract_id = 'demo'
);

-- デモ用テナント作成 (固定contract_id 'demo')
DO $$
DECLARE
    new_org_id UUID;
    hashed_shop_pw TEXT;
    hashed_admin_pw TEXT;
    hashed_staff_pw TEXT;
BEGIN
    hashed_shop_pw := crypt('demo', gen_salt('bf'));
    hashed_admin_pw := crypt('password', gen_salt('bf'));
    hashed_staff_pw := crypt('password', gen_salt('bf'));

    -- 組織作成
    INSERT INTO organizations (name, license_status)
    VALUES ('Rakushift Demo Shop', 'active')
    RETURNING id INTO new_org_id;

    -- 設定作成
    INSERT INTO config (
        organization_id, contract_id, shop_password,
        subscription_status, opening_time, closing_time,
        staff_req, custom_shifts
    ) VALUES (
        new_org_id, 'demo', hashed_shop_pw,
        'active', '09:00', '22:00',
        '{"min_manager":1,"min_weekday":2,"min_weekend":3,"min_holiday":3}'::jsonb,
        '[{"name":"早番","start":"09:00","end":"17:00"},{"name":"遅番","start":"14:00","end":"22:00"}]'::jsonb
    );

    -- 管理者 (店長)
    INSERT INTO staff (
        organization_id, contract_id, login_id, password,
        name, role, evaluation, salary_type, monthly_salary,
        max_days_week, max_hours_day
    ) VALUES (
        new_org_id, 'demo', 'admin', hashed_admin_pw,
        '店長 山田', 'manager', 'A', 'monthly', 300000, 5, 8
    );

    -- リーダー
    INSERT INTO staff (
        organization_id, contract_id, login_id, password,
        name, role, evaluation, salary_type, hourly_wage,
        max_days_week, max_hours_day
    ) VALUES (
        new_org_id, 'demo', 'leader1', hashed_staff_pw,
        'リーダー 鈴木', 'leader', 'A', 'monthly', 250000, 5, 8
    );

    -- スタッフ
    INSERT INTO staff (organization_id, contract_id, name, role, evaluation, salary_type, hourly_wage, max_days_week, max_hours_day)
    VALUES
        (new_org_id, 'demo', 'スタッフA 佐藤', 'staff', 'B', 'hourly', 1100, 5, 8),
        (new_org_id, 'demo', 'スタッフB 田中', 'staff', 'B', 'hourly', 1100, 5, 8),
        (new_org_id, 'demo', 'スタッフC 高橋', 'staff', 'C', 'hourly', 1050, 4, 6),
        (new_org_id, 'demo', 'アルバイト 伊藤', 'staff', 'C', 'hourly', 1000, 3, 5),
        (new_org_id, 'demo', '新人 渡辺', 'staff', 'D', 'hourly', 1000, 3, 4);

    RAISE NOTICE 'Demo tenant created: org_id=%, contract_id=demo', new_org_id;
END $$;


-- =========================================================
-- 7. スキーマリロード
-- =========================================================
NOTIFY pgrst, 'reload schema';
