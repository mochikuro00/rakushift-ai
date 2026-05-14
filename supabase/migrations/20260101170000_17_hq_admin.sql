-- 17_hq_admin.sql
-- ===========================================================
-- Migration: HQ Admin (統括管理者) アカウント機能
-- ===========================================================

-- 1. hq_admins テーブルの作成
CREATE TABLE IF NOT EXISTS hq_admins (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    login_id TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 2. 初期アカウントの発行 (ID: hq_master, Pass: rakushift_hq)
INSERT INTO hq_admins (login_id, password) 
VALUES ('hq_master', crypt('rakushift_hq', gen_salt('bf')))
ON CONFLICT (login_id) DO NOTHING;

-- 3. 本部ログイン用RPC
CREATE OR REPLACE FUNCTION hq_login(p_login_id TEXT, p_password TEXT) 
RETURNS JSONB AS $$
DECLARE
    v_admin RECORD;
BEGIN
    SELECT * INTO v_admin FROM hq_admins WHERE login_id = p_login_id;
    IF NOT FOUND THEN 
        RETURN jsonb_build_object('status', 'error', 'message', '本部IDが存在しません'); 
    END IF;

    IF v_admin.password = crypt(p_password, v_admin.password) THEN
        RETURN jsonb_build_object(
            'status', 'success', 
            'role', 'hq_admin',
            'login_id', v_admin.login_id
        );
    ELSE
        RETURN jsonb_build_object('status', 'error', 'message', 'パスワードが違います');
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 4. 全店舗一覧取得RPC
CREATE OR REPLACE FUNCTION hq_get_all_shops() 
RETURNS JSONB AS $$
DECLARE
    res JSONB;
BEGIN
    SELECT jsonb_agg(jsonb_build_object(
        'organization_id', o.id,
        'name', o.name,
        'contract_id', c.contract_id,
        'plan', c.stripe_plan,
        'created_at', o.created_at
    ) ORDER BY o.created_at DESC) INTO res
    FROM organizations o
    JOIN config c ON o.id = c.organization_id;
    
    RETURN COALESCE(res, '[]'::jsonb);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
