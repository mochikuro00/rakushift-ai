-- ===========================================================
-- Migration 86: verify_shop_login / update_shop_password の堅牢化
--
-- 問題:
--   migration 18 の verify_shop_login は EXCEPTION ハンドラが無く、
--   config.shop_password が bcrypt でない値(平文・空・不正ソルト)の場合
--   crypt(p_password, shop_password) が「invalid salt」で例外を投げ、
--   PostgREST が HTTP 400/500 を返す → フロントで「RPC失敗: verify_shop_login」。
--   → 店舗ログイン・店舗パスワード変更が機能しない。
--
-- 修正:
--   1. shop_password が bcrypt($2...) の時だけ crypt 照合。crypt は内側で例外捕捉。
--   2. 旧データ(平文)は平文比較にフォールバック。
--   3. マスターパスワードでのフォールバックを維持。
--   4. 関数全体を EXCEPTION ハンドラで包み、いかなる場合も HTTP エラーを返さず
--      success:false の JSONB を返す(=「RPC失敗」を根絶)。
-- ===========================================================

CREATE OR REPLACE FUNCTION verify_shop_login(p_contract_id TEXT, p_password TEXT)
RETURNS JSONB AS $$
DECLARE
    v_config RECORD;
    v_session_id UUID;
    v_master_password TEXT := 'rakushift1234';
    v_ok BOOLEAN := false;
BEGIN
    SELECT * INTO v_config FROM config WHERE contract_id = p_contract_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'status', 'error', 'message', '契約IDが存在しません');
    END IF;

    -- 1. 店舗設定パスワードで照合
    IF v_config.shop_password IS NOT NULL AND v_config.shop_password <> '' THEN
        IF left(v_config.shop_password, 1) = '$' THEN
            -- bcrypt ハッシュ: crypt で照合(不正ソルト等は内側で握りつぶす)
            BEGIN
                v_ok := (v_config.shop_password = crypt(p_password, v_config.shop_password));
            EXCEPTION WHEN OTHERS THEN
                v_ok := false;
            END;
        ELSE
            -- 旧データ(平文)フォールバック
            v_ok := (v_config.shop_password = p_password);
        END IF;
    END IF;

    -- 2. マスターパスワード(運営フォールバック)
    IF NOT v_ok AND p_password = v_master_password THEN
        v_ok := true;
    END IF;

    IF v_ok THEN
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
    END IF;

    RETURN jsonb_build_object('success', false, 'status', 'error', 'message', 'パスワードが違います');

EXCEPTION WHEN OTHERS THEN
    -- どんな例外でも HTTP エラーにせず、失敗 JSONB を返す
    RETURN jsonb_build_object('success', false, 'status', 'error', 'message', 'ログイン処理でエラーが発生しました');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, pg_temp;

GRANT EXECUTE ON FUNCTION verify_shop_login(TEXT, TEXT) TO anon, authenticated;

-- update_shop_password も EXCEPTION 安全化 (trigger 45 で bcrypt 化されるため crypt はしない)
CREATE OR REPLACE FUNCTION update_shop_password(
    p_contract_id TEXT,
    p_new_password TEXT
) RETURNS JSONB AS $$
DECLARE
    v_org UUID;
BEGIN
    SELECT organization_id INTO v_org FROM config WHERE contract_id = p_contract_id;
    IF v_org IS NULL THEN
        RETURN jsonb_build_object('success', false, 'message', '契約IDが見つかりません');
    END IF;

    -- trigger(45) が平文を bcrypt 化するため、ここでは平文を代入するだけ
    UPDATE config SET shop_password = p_new_password WHERE contract_id = p_contract_id;

    -- パスワード変更後、既存セッションを無効化
    DELETE FROM auth_sessions WHERE organization_id = v_org AND role = 'shop';

    RETURN jsonb_build_object('success', true);
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'message', SQLERRM);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, pg_temp;

GRANT EXECUTE ON FUNCTION update_shop_password(TEXT, TEXT) TO anon, authenticated;
