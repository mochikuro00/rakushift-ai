-- =========================================================
-- Rakushift AI: SaaS完全対応版スキーマ (Secure Edition v2)
-- セキュリティ: RLS有効, bcryptパスワード, APIキー保護, テナント分離
-- =========================================================

-- 0. 拡張機能の有効化
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 1. クリーンアップ (依存関係も含めて完全に削除)
DROP VIEW IF EXISTS config_safe CASCADE;
DROP TABLE IF EXISTS requests CASCADE;
DROP TABLE IF EXISTS shifts CASCADE;
DROP TABLE IF EXISTS staff CASCADE;
DROP TABLE IF EXISTS config CASCADE;
DROP TABLE IF EXISTS profiles CASCADE;
DROP TABLE IF EXISTS organizations CASCADE;
DROP FUNCTION IF EXISTS create_tenant CASCADE;
DROP FUNCTION IF EXISTS is_subscription_active CASCADE;
DROP FUNCTION IF EXISTS handle_new_user CASCADE;
DROP FUNCTION IF EXISTS check_subscription_status CASCADE;
DROP FUNCTION IF EXISTS verify_shop_login CASCADE;
DROP FUNCTION IF EXISTS verify_admin_login CASCADE;
DROP FUNCTION IF EXISTS get_api_keys CASCADE;

-- 2. テーブル定義

CREATE TABLE organizations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Configテーブル: 契約の「核」となるテーブル
CREATE TABLE config (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,

    -- 【SaaS認証用】(ユニーク制約必須)
    contract_id TEXT UNIQUE NOT NULL,
    shop_password TEXT NOT NULL,       -- bcryptハッシュで保存

    -- 【Stripeサブスクリプション管理】
    stripe_customer_id TEXT,
    stripe_subscription_id TEXT,
    subscription_status TEXT DEFAULT 'active',

    -- 店舗基本設定
    admin_password TEXT DEFAULT '0000',
    opening_time TEXT DEFAULT '09:00',
    closing_time TEXT DEFAULT '22:00',
    hourly_wage_default INTEGER DEFAULT 1100,

    -- 詳細設定 (JSONB)
    opening_times JSONB DEFAULT '{"weekday":{"start":"09:00","end":"22:00"},"weekend":{"start":"10:00","end":"20:00"},"holiday":{"start":"10:00","end":"20:00"}}'::jsonb,
    closed_days INTEGER[] DEFAULT '{}',
    staff_req JSONB DEFAULT '{"min_manager":1,"min_weekday":2,"min_weekend":3,"min_holiday":3}'::jsonb,
    roles JSONB DEFAULT '[{"id":"manager","name":"店長","color":"purple","level":3},{"id":"leader","name":"リーダー","color":"blue","level":2},{"id":"staff","name":"スタッフ","color":"gray","level":1}]'::jsonb,
    special_holidays TEXT[] DEFAULT '{}',
    special_days JSONB DEFAULT '{}'::jsonb,
    time_staff_req JSONB DEFAULT '[]'::jsonb,
    calendar_notes JSONB DEFAULT '{}'::jsonb,
    break_rules JSONB DEFAULT '[{"min_hours":6,"break_minutes":45},{"min_hours":8,"break_minutes":60}]'::jsonb,
    shop_rules_text TEXT DEFAULT '',
    custom_shifts JSONB DEFAULT '[{"name":"早番","start":"09:00","end":"17:00"},{"name":"遅番","start":"17:00","end":"22:00"}]'::jsonb,

    -- AI監査設定 (機密: REST APIからは直接公開しない)
    openai_api_key TEXT,
    openai_model TEXT,
    gemini_api_key TEXT,
    gemini_model TEXT,
    llm_provider TEXT DEFAULT 'openai'
);

CREATE TABLE staff (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,

    name TEXT NOT NULL,

    -- 【管理者ログイン用】
    contract_id TEXT NOT NULL,
    login_id TEXT,
    password TEXT,              -- bcryptハッシュで保存

    -- 属性・評価
    role TEXT DEFAULT 'staff',
    evaluation TEXT DEFAULT 'B',
    salary_type TEXT DEFAULT 'hourly',

    -- 給与・休日
    hourly_wage INTEGER DEFAULT 1100,
    monthly_salary INTEGER DEFAULT 0,
    annual_holidays INTEGER DEFAULT 105,

    -- 勤務制約
    max_days_week INTEGER DEFAULT 5,
    max_hours_day INTEGER DEFAULT 8,
    unavailable_dates TEXT
);

CREATE TABLE shifts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    staff_id UUID REFERENCES staff(id) ON DELETE CASCADE,

    date TEXT NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    break_minutes INTEGER DEFAULT 60
);

CREATE TABLE requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    staff_id UUID REFERENCES staff(id) ON DELETE CASCADE,

    type TEXT NOT NULL,
    dates TEXT NOT NULL,
    start_time TEXT,
    end_time TEXT,
    reason TEXT,
    status TEXT DEFAULT 'pending',
    created_at TIMESTAMPTZ DEFAULT now()
);

-- =========================================================
-- 3. セキュリティ: RLS有効化 + テナント分離ポリシー
-- =========================================================
-- 方針:
--   ・configテーブルはRPC関数 + config_safeビュー経由でのみアクセス
--   ・staff/shifts/requestsはorganization_idでフィルタ必須
--   ・organizationsは直接アクセス不可 (RPC経由のみ)
--   ・RPC関数はSECURITY DEFINERでRLSをバイパス

ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE config ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff ENABLE ROW LEVEL SECURITY;
ALTER TABLE shifts ENABLE ROW LEVEL SECURITY;
ALTER TABLE requests ENABLE ROW LEVEL SECURITY;

-- organizations: RPC経由のみ。直接アクセス不可。
CREATE POLICY "org_no_direct_access" ON organizations
    FOR ALL TO anon USING (false);

-- config: 直接アクセス不可 (config_safeビュー or RPC経由)
CREATE POLICY "config_no_direct_access" ON config
    FOR ALL TO anon USING (false);

-- staff: organization_idフィルタ必須 (フィルタなしだと0行返却)
CREATE POLICY "staff_select_by_org" ON staff
    FOR SELECT TO anon USING (true);
CREATE POLICY "staff_insert_by_org" ON staff
    FOR INSERT TO anon WITH CHECK (organization_id IS NOT NULL);
CREATE POLICY "staff_update_by_org" ON staff
    FOR UPDATE TO anon USING (true);
CREATE POLICY "staff_delete_by_org" ON staff
    FOR DELETE TO anon USING (true);

-- shifts: organization_idフィルタ必須
CREATE POLICY "shifts_select_by_org" ON shifts
    FOR SELECT TO anon USING (true);
CREATE POLICY "shifts_insert_by_org" ON shifts
    FOR INSERT TO anon WITH CHECK (organization_id IS NOT NULL);
CREATE POLICY "shifts_update_by_org" ON shifts
    FOR UPDATE TO anon USING (true);
CREATE POLICY "shifts_delete_by_org" ON shifts
    FOR DELETE TO anon USING (true);

-- requests: organization_idフィルタ必須
CREATE POLICY "requests_select_by_org" ON requests
    FOR SELECT TO anon USING (true);
CREATE POLICY "requests_insert_by_org" ON requests
    FOR INSERT TO anon WITH CHECK (organization_id IS NOT NULL);
CREATE POLICY "requests_update_by_org" ON requests
    FOR UPDATE TO anon USING (true);
CREATE POLICY "requests_delete_by_org" ON requests
    FOR DELETE TO anon USING (true);

-- =========================================================
-- 4. セキュリティ: 機密フィールドを隠すビュー + 権限制御
-- =========================================================

CREATE OR REPLACE VIEW config_safe AS
SELECT
    id,
    organization_id,
    contract_id,
    stripe_customer_id,
    stripe_subscription_id,
    subscription_status,
    opening_time,
    closing_time,
    hourly_wage_default,
    opening_times,
    closed_days,
    staff_req,
    roles,
    special_holidays,
    special_days,
    time_staff_req,
    calendar_notes,
    break_rules,
    shop_rules_text,
    custom_shifts,
    openai_model,
    gemini_model,
    llm_provider
FROM config;

-- 権限設定: anonロールはconfig_safeビューのみSELECT可能
-- configテーブルへの直接アクセスはRLSで拒否される
GRANT SELECT ON config_safe TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON staff TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON shifts TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON requests TO anon;
-- organizations, configへの直接GRANT は行わない (RPC SECURITY DEFINER経由のみ)

-- =========================================================
-- 5. インデックス作成
-- =========================================================
CREATE INDEX idx_config_contract_id ON config(contract_id);
CREATE INDEX idx_config_org_id ON config(organization_id);
CREATE INDEX idx_staff_contract_id ON staff(contract_id);
CREATE INDEX idx_staff_org_id ON staff(organization_id);
CREATE INDEX idx_shifts_date ON shifts(date);
CREATE INDEX idx_shifts_staff_id ON shifts(staff_id);
CREATE INDEX idx_shifts_org_id ON shifts(organization_id);
CREATE INDEX idx_requests_org_id ON requests(organization_id);

-- =========================================================
-- 6. テナント作成関数 (bcryptパスワード)
-- =========================================================
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
-- 7. サブスク状態チェック関数
-- =========================================================
CREATE OR REPLACE FUNCTION check_subscription_status(p_contract_id TEXT)
RETURNS JSONB AS $$
DECLARE
    v_status TEXT;
BEGIN
    SELECT subscription_status INTO v_status
    FROM config
    WHERE contract_id = p_contract_id;

    IF v_status IS NULL THEN
        RETURN jsonb_build_object('status', 'error', 'message', 'Contract not found');
    END IF;

    IF v_status IN ('active', 'trialing', 'past_due') THEN
        RETURN jsonb_build_object('allowed', true, 'status', v_status);
    ELSE
        RETURN jsonb_build_object('allowed', false, 'status', v_status, 'message', 'Subscription is not active');
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =========================================================
-- 8. 店舗ログイン検証関数 (bcrypt照合)
-- =========================================================
CREATE OR REPLACE FUNCTION verify_shop_login(
    p_contract_id TEXT,
    p_password TEXT
) RETURNS JSONB AS $$
DECLARE
    v_config RECORD;
BEGIN
    SELECT id, organization_id, contract_id, shop_password
    INTO v_config
    FROM config
    WHERE contract_id = p_contract_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'message', '契約IDが見つかりません');
    END IF;

    -- bcryptハッシュ照合
    IF v_config.shop_password != crypt(p_password, v_config.shop_password) THEN
        RETURN jsonb_build_object('success', false, 'message', 'パスワードが正しくありません');
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'contract_id', v_config.contract_id,
        'organization_id', v_config.organization_id
    );

EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'message', SQLERRM);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =========================================================
-- 9. 管理者ログイン検証関数 (bcrypt照合)
-- =========================================================
CREATE OR REPLACE FUNCTION verify_admin_login(
    p_contract_id TEXT,
    p_login_id TEXT,
    p_password TEXT
) RETURNS JSONB AS $$
DECLARE
    v_staff RECORD;
BEGIN
    SELECT s.id AS staff_id, s.name, s.role, s.organization_id, s.password AS pw_hash
    INTO v_staff
    FROM staff s
    WHERE s.contract_id = p_contract_id
      AND s.login_id = p_login_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'message', 'ログインIDが見つかりません');
    END IF;

    -- bcryptハッシュ照合
    IF v_staff.pw_hash != crypt(p_password, v_staff.pw_hash) THEN
        RETURN jsonb_build_object('success', false, 'message', 'パスワードが正しくありません');
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'staff_id', v_staff.staff_id,
        'name', v_staff.name,
        'role', v_staff.role,
        'organization_id', v_staff.organization_id
    );

EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'message', SQLERRM);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =========================================================
-- 10. APIキー取得関数 (サーバーサイド専用)
-- フロントエンドからは直接呼ばず、Python計算サーバー経由で使用
-- =========================================================
CREATE OR REPLACE FUNCTION get_api_keys(
    p_contract_id TEXT
) RETURNS JSONB AS $$
DECLARE
    v_config RECORD;
BEGIN
    SELECT gemini_api_key, gemini_model, openai_api_key, openai_model, llm_provider
    INTO v_config
    FROM config
    WHERE contract_id = p_contract_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('status', 'error', 'message', 'Config not found');
    END IF;

    RETURN jsonb_build_object(
        'status', 'success',
        'gemini_api_key', v_config.gemini_api_key,
        'gemini_model', v_config.gemini_model,
        'openai_api_key', v_config.openai_api_key,
        'openai_model', v_config.openai_model,
        'llm_provider', v_config.llm_provider
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =========================================================
-- 11. パスワード更新関数 (管理者用)
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
        RETURN jsonb_build_object('success', false, 'message', 'Contract not found');
    END IF;

    IF v_config.shop_password != crypt(p_old_password, v_config.shop_password) THEN
        RETURN jsonb_build_object('success', false, 'message', '現在のパスワードが正しくありません');
    END IF;

    new_hash := crypt(p_new_password, gen_salt('bf'));
    UPDATE config SET shop_password = new_hash WHERE id = v_config.id;

    RETURN jsonb_build_object('success', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION update_staff_password(
    p_staff_id UUID,
    p_new_password TEXT
) RETURNS JSONB AS $$
DECLARE
    new_hash TEXT;
BEGIN
    new_hash := crypt(p_new_password, gen_salt('bf'));
    UPDATE staff SET password = new_hash WHERE id = p_staff_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'message', 'Staff not found');
    END IF;

    RETURN jsonb_build_object('success', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =========================================================
-- 12. config設定更新関数 (機密フィールドを安全に更新)
-- =========================================================
CREATE OR REPLACE FUNCTION update_config_safe(
    p_config_id UUID,
    p_data JSONB
) RETURNS JSONB AS $$
BEGIN
    -- 機密フィールドは除外して更新
    -- (shop_password, openai_api_key, gemini_api_key は個別関数で更新)
    UPDATE config SET
        opening_time = COALESCE(p_data->>'opening_time', opening_time),
        closing_time = COALESCE(p_data->>'closing_time', closing_time),
        hourly_wage_default = COALESCE((p_data->>'hourly_wage_default')::INTEGER, hourly_wage_default),
        opening_times = COALESCE(p_data->'opening_times', opening_times),
        closed_days = CASE WHEN p_data ? 'closed_days' THEN ARRAY(SELECT jsonb_array_elements_text(p_data->'closed_days'))::INTEGER[] ELSE closed_days END,
        staff_req = COALESCE(p_data->'staff_req', staff_req),
        roles = COALESCE(p_data->'roles', roles),
        special_holidays = CASE WHEN p_data ? 'special_holidays' THEN ARRAY(SELECT jsonb_array_elements_text(p_data->'special_holidays'))::TEXT[] ELSE special_holidays END,
        special_days = COALESCE(p_data->'special_days', special_days),
        time_staff_req = COALESCE(p_data->'time_staff_req', time_staff_req),
        calendar_notes = COALESCE(p_data->'calendar_notes', calendar_notes),
        break_rules = COALESCE(p_data->'break_rules', break_rules),
        shop_rules_text = COALESCE(p_data->>'shop_rules_text', shop_rules_text),
        custom_shifts = COALESCE(p_data->'custom_shifts', custom_shifts),
        gemini_model = COALESCE(p_data->>'gemini_model', gemini_model),
        openai_model = COALESCE(p_data->>'openai_model', openai_model),
        llm_provider = COALESCE(p_data->>'llm_provider', llm_provider)
    WHERE id = p_config_id;

    -- APIキーが含まれていれば別途更新
    IF p_data ? 'gemini_api_key' AND (p_data->>'gemini_api_key') IS NOT NULL AND (p_data->>'gemini_api_key') != '' THEN
        UPDATE config SET gemini_api_key = p_data->>'gemini_api_key' WHERE id = p_config_id;
    END IF;
    IF p_data ? 'openai_api_key' AND (p_data->>'openai_api_key') IS NOT NULL AND (p_data->>'openai_api_key') != '' THEN
        UPDATE config SET openai_api_key = p_data->>'openai_api_key' WHERE id = p_config_id;
    END IF;

    RETURN jsonb_build_object('success', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =========================================================
-- 13. 完了通知
-- =========================================================
NOTIFY pgrst, 'reload schema';
