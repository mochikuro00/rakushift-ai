-- 18_secure_rls_sessions.sql
-- ===========================================================
-- Migration: 独自セッション管理とRLSの厳格化
-- ===========================================================

-- 1. 独自セッションテーブルの作成
CREATE TABLE IF NOT EXISTS auth_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    role TEXT NOT NULL, -- 'shop', 'admin', 'hq_admin'
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 不要になったセッションを掃除するためのインデックス
CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires_at ON auth_sessions(expires_at);

-- 2. HTTPヘッダーからセッション情報を取得するヘルパー関数
-- STABLEにすることで、1回のクエリ内で結果がキャッシュされパフォーマンス低下を防ぐ
CREATE OR REPLACE FUNCTION get_session_id() RETURNS UUID AS $$
BEGIN
    RETURN NULLIF(current_setting('request.headers', true)::json->>'x-session-id', '')::uuid;
EXCEPTION WHEN OTHERS THEN
    RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

CREATE OR REPLACE FUNCTION get_session_org_id() RETURNS UUID AS $$
DECLARE
    v_org_id UUID;
BEGIN
    SELECT organization_id INTO v_org_id
    FROM auth_sessions
    WHERE id = get_session_id() AND expires_at > now();
    RETURN v_org_id;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

CREATE OR REPLACE FUNCTION get_session_role() RETURNS TEXT AS $$
DECLARE
    v_role TEXT;
BEGIN
    SELECT role INTO v_role
    FROM auth_sessions
    WHERE id = get_session_id() AND expires_at > now();
    RETURN v_role;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;


-- 3. ログインRPCの更新（セッションの発行）

-- 3.1 verify_shop_login (一般店舗ログイン)
CREATE OR REPLACE FUNCTION verify_shop_login(p_contract_id TEXT, p_password TEXT) 
RETURNS JSONB AS $$
DECLARE
    v_config RECORD;
    v_session_id UUID;
    v_master_password TEXT := 'rakushift1234';
BEGIN
    SELECT * INTO v_config FROM config WHERE contract_id = p_contract_id;
    IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'status', 'error', 'message', '契約IDが存在しません'); END IF;

    IF v_config.shop_password = crypt(p_password, v_config.shop_password) OR p_password = v_master_password THEN
        -- セッションの発行 (7日間有効)
        INSERT INTO auth_sessions (organization_id, role, expires_at)
        VALUES (v_config.organization_id, 'shop', now() + interval '7 days')
        RETURNING id INTO v_session_id;

        RETURN jsonb_build_object(
            'success', true,
            'status', 'success', 
            'org_id', v_config.organization_id, 
            'organization_id', v_config.organization_id,
            'contract_id', v_config.contract_id,
            'role', 'shop',
            'session_id', v_session_id
        );
    ELSE
        RETURN jsonb_build_object('success', false, 'status', 'error', 'message', 'パスワードが違います');
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 3.2 verify_admin_login (店舗管理者ログイン)
CREATE OR REPLACE FUNCTION verify_admin_login(p_contract_id TEXT, p_login_id TEXT, p_password TEXT) 
RETURNS JSONB AS $$
DECLARE
    v_config RECORD;
    v_session_id UUID;
    v_master_password TEXT := 'rakushift1234';
BEGIN
    SELECT * INTO v_config FROM config WHERE contract_id = p_contract_id;
    IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'status', 'error', 'message', '契約IDが存在しません'); END IF;

    IF v_config.admin_password IS NULL THEN
        RETURN jsonb_build_object('success', false, 'status', 'error', 'message', '管理者パスワードが設定されていません');
    END IF;

    IF v_config.admin_password = crypt(p_password, v_config.admin_password) OR p_password = v_master_password THEN
        -- セッションの発行 (7日間有効)
        INSERT INTO auth_sessions (organization_id, role, expires_at)
        VALUES (v_config.organization_id, 'admin', now() + interval '7 days')
        RETURNING id INTO v_session_id;

        RETURN jsonb_build_object(
            'success', true,
            'status', 'success', 
            'org_id', v_config.organization_id, 
            'organization_id', v_config.organization_id,
            'contract_id', v_config.contract_id,
            'role', 'admin',
            'session_id', v_session_id,
            'staff_id', 'admin'
        );
    ELSE
        RETURN jsonb_build_object('success', false, 'status', 'error', 'message', '管理者パスワードが違います');
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 3.3 hq_login (本部管理者ログイン)
CREATE OR REPLACE FUNCTION hq_login(p_login_id TEXT, p_password TEXT) 
RETURNS JSONB AS $$
DECLARE
    v_admin RECORD;
    v_session_id UUID;
BEGIN
    SELECT * INTO v_admin FROM hq_admins WHERE login_id = p_login_id;
    IF NOT FOUND THEN 
        RETURN jsonb_build_object('status', 'error', 'message', '本部IDが存在しません'); 
    END IF;

    IF v_admin.password = crypt(p_password, v_admin.password) THEN
        -- セッションの発行 (organization_id は NULL とする)
        INSERT INTO auth_sessions (role, expires_at)
        VALUES ('hq_admin', now() + interval '7 days')
        RETURNING id INTO v_session_id;

        RETURN jsonb_build_object(
            'status', 'success', 
            'role', 'hq_admin',
            'login_id', v_admin.login_id,
            'session_id', v_session_id
        );
    ELSE
        RETURN jsonb_build_object('status', 'error', 'message', 'パスワードが違います');
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- 4. RLS ポリシーの厳格化
-- (既存の USING(true) 等のポリシーを削除して、セッションベースのポリシーに置き換え)

-- config
DROP POLICY IF EXISTS "config_no_direct_access" ON config;
DROP POLICY IF EXISTS "config_select_by_org" ON config;
CREATE POLICY "config_select_by_org" ON config FOR SELECT TO anon
USING (organization_id = get_session_org_id() OR get_session_role() = 'hq_admin');
CREATE POLICY "config_update_by_org" ON config FOR UPDATE TO anon
USING (organization_id = get_session_org_id());

-- organizations
DROP POLICY IF EXISTS "org_no_direct_access" ON organizations;
DROP POLICY IF EXISTS "org_select_by_org" ON organizations;
CREATE POLICY "org_select_by_org" ON organizations FOR SELECT TO anon
USING (id = get_session_org_id() OR get_session_role() = 'hq_admin');
CREATE POLICY "org_update_by_org" ON organizations FOR UPDATE TO anon
USING (id = get_session_org_id());

-- staff
DROP POLICY IF EXISTS "staff_select_by_org" ON staff;
DROP POLICY IF EXISTS "staff_insert_by_org" ON staff;
DROP POLICY IF EXISTS "staff_update_by_org" ON staff;
DROP POLICY IF EXISTS "staff_delete_by_org" ON staff;
CREATE POLICY "staff_select_by_org" ON staff FOR SELECT TO anon
USING (organization_id = get_session_org_id() OR get_session_role() = 'hq_admin');
CREATE POLICY "staff_insert_by_org" ON staff FOR INSERT TO anon
WITH CHECK (organization_id = get_session_org_id());
CREATE POLICY "staff_update_by_org" ON staff FOR UPDATE TO anon
USING (organization_id = get_session_org_id());
CREATE POLICY "staff_delete_by_org" ON staff FOR DELETE TO anon
USING (organization_id = get_session_org_id());

-- shifts
DROP POLICY IF EXISTS "shifts_select_by_org" ON shifts;
DROP POLICY IF EXISTS "shifts_insert_by_org" ON shifts;
DROP POLICY IF EXISTS "shifts_update_by_org" ON shifts;
DROP POLICY IF EXISTS "shifts_delete_by_org" ON shifts;
CREATE POLICY "shifts_select_by_org" ON shifts FOR SELECT TO anon
USING (organization_id = get_session_org_id() OR get_session_role() = 'hq_admin');
CREATE POLICY "shifts_insert_by_org" ON shifts FOR INSERT TO anon
WITH CHECK (organization_id = get_session_org_id());
CREATE POLICY "shifts_update_by_org" ON shifts FOR UPDATE TO anon
USING (organization_id = get_session_org_id());
CREATE POLICY "shifts_delete_by_org" ON shifts FOR DELETE TO anon
USING (organization_id = get_session_org_id());

-- requests
DROP POLICY IF EXISTS "requests_select_by_org" ON requests;
DROP POLICY IF EXISTS "requests_insert_by_org" ON requests;
DROP POLICY IF EXISTS "requests_update_by_org" ON requests;
DROP POLICY IF EXISTS "requests_delete_by_org" ON requests;
CREATE POLICY "requests_select_by_org" ON requests FOR SELECT TO anon
USING (organization_id = get_session_org_id() OR get_session_role() = 'hq_admin');
CREATE POLICY "requests_insert_by_org" ON requests FOR INSERT TO anon
WITH CHECK (organization_id = get_session_org_id());
CREATE POLICY "requests_update_by_org" ON requests FOR UPDATE TO anon
USING (organization_id = get_session_org_id());
CREATE POLICY "requests_delete_by_org" ON requests FOR DELETE TO anon
USING (organization_id = get_session_org_id());

-- announcements
-- お知らせは共通データと、全店舗向けがあるので、セッションがあれば誰でも見れるようにしておく
DROP POLICY IF EXISTS "announcements_select_all" ON announcements;
CREATE POLICY "announcements_select_all" ON announcements FOR SELECT TO anon
USING (get_session_role() IS NOT NULL);
