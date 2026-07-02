-- =========================================================
-- 73_fix_verify_admin_login_password.sql
-- 目的: 管理者パスワードを変更しても新パスワードでログインできない不具合の修正。
--
-- 症状: パスワード変更(update_admin_password_by_contract で config.admin_password を
--       bcrypt 更新)しても、ログイン時 verify_admin_login が新パスワードを弾き、
--       マスター(rakushift1234)のみ通る。
-- 原因: 本番の verify_admin_login が config.admin_password を正しく bcrypt 照合して
--       いない/マスター常時バイパスが残っている。
--
-- 本SQLは verify_admin_login を「config.admin_password を bcrypt 照合」する正しい
-- 定義に統一する。マスターは admin_password 未設定時の初期化のみ許可し、常時
-- バイパスは廃止する(パスワード変更が確実に反映される)。
--
-- ⚠ 適用前に必ず現行定義をバックアップしてください:
--   SELECT pg_get_functiondef('public.verify_admin_login(text,text,text)'::regprocedure);
-- =========================================================

CREATE OR REPLACE FUNCTION verify_admin_login(p_contract_id TEXT, p_login_id TEXT, p_password TEXT)
RETURNS JSONB AS $$
DECLARE
    v_config RECORD;
    v_session_id UUID;
    v_master_password TEXT := 'rakushift1234';  -- 初期化専用(admin_password 未設定時のみ有効)
    v_ok BOOLEAN := false;
BEGIN
    SELECT * INTO v_config FROM config WHERE contract_id = p_contract_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'status', 'error', 'message', '契約IDが存在しません');
    END IF;

    IF v_config.admin_password IS NULL OR v_config.admin_password = '' THEN
        -- 初期化: まだ管理者パスワード未設定 → マスターのみ許可
        v_ok := (p_password = v_master_password);
    ELSIF v_config.admin_password LIKE '$2%' THEN
        -- bcrypt ハッシュ: 正しく照合 (マスター常時バイパスは廃止)
        v_ok := (v_config.admin_password = crypt(p_password, v_config.admin_password));
    ELSE
        -- 平文で保存されている既存データ(移行途中)の互換
        v_ok := (v_config.admin_password = p_password);
    END IF;

    IF NOT v_ok THEN
        RETURN jsonb_build_object('success', false, 'status', 'error', 'message', '管理者パスワードが違います');
    END IF;

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
        'name', '管理者',
        'session_id', v_session_id,
        'staff_id', 'admin'
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, pg_temp;

GRANT EXECUTE ON FUNCTION verify_admin_login(TEXT, TEXT, TEXT) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
