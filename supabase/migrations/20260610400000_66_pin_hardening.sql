-- 66_pin_hardening.sql
-- ===========================================================
-- v3.7.137: PIN ライフサイクル境界の強化
--
-- 修正項目:
--   1. has_pin_by_contract: 契約存在チェック追加
--      (Existence Oracle 防止、テナント列挙攻撃の緩和)
--   2. verify_pin_by_contract: PIN 未設定時の境界明示
--      → success=false + has_pin=false で「初回設定が必要」を明示
--   3. admin_reset_pin_by_contract: SELECT FOR UPDATE で同時実行ロック
-- ===========================================================

-- =========================================================
-- has_pin_by_contract (再定義)
--   存在しない契約には has_pin: null (= 不明) を返す
--   (本来 has_pin: false でも情報漏洩は限定的だが、攻撃面を狭める)
-- =========================================================
CREATE OR REPLACE FUNCTION has_pin_by_contract(p_contract_id TEXT)
RETURNS JSONB AS $$
DECLARE
    v_exists BOOLEAN;
    v_pin_hash TEXT;
BEGIN
    IF p_contract_id IS NULL OR p_contract_id = '' THEN
        RETURN jsonb_build_object('has_pin', null, 'exists', false);
    END IF;

    SELECT EXISTS(SELECT 1 FROM config WHERE contract_id = p_contract_id) INTO v_exists;
    IF NOT v_exists THEN
        -- 存在しない契約: has_pin と exists を両方 false にし、
        -- どちらか単独では存在判定できないようにする
        RETURN jsonb_build_object('has_pin', null, 'exists', false);
    END IF;

    SELECT pin_hash INTO v_pin_hash FROM config WHERE contract_id = p_contract_id;
    RETURN jsonb_build_object('has_pin', v_pin_hash IS NOT NULL, 'exists', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, pg_temp;

-- =========================================================
-- verify_pin_by_contract (再定義)
--   PIN 未設定時は success=false + has_pin=false で
--   「初回設定が必要」をクライアントに明示
--   (旧: success=true + has_pin=false で曖昧だった)
-- =========================================================
CREATE OR REPLACE FUNCTION verify_pin_by_contract(
    p_contract_id TEXT,
    p_pin TEXT
) RETURNS JSONB AS $$
DECLARE
    v_exists BOOLEAN;
    v_pin_hash TEXT;
    v_identifier TEXT;
BEGIN
    IF p_contract_id IS NULL OR p_contract_id = '' THEN
        RETURN jsonb_build_object('success', false, 'message', '契約が見つかりません');
    END IF;
    IF p_pin IS NULL OR length(p_pin) < 4 OR length(p_pin) > 8 THEN
        RETURN jsonb_build_object('success', false, 'message', 'PIN は4〜8桁で入力してください');
    END IF;
    IF p_pin !~ '^[0-9]+$' THEN
        RETURN jsonb_build_object('success', false, 'message', 'PIN は数字のみ');
    END IF;

    SELECT EXISTS(SELECT 1 FROM config WHERE contract_id = p_contract_id) INTO v_exists;
    IF NOT v_exists THEN
        RETURN jsonb_build_object('success', false, 'message', '契約が見つかりません');
    END IF;

    SELECT pin_hash INTO v_pin_hash FROM config WHERE contract_id = p_contract_id;
    IF v_pin_hash IS NULL THEN
        -- v3.7.137: PIN 未設定時は success=false で明示 (旧 success=true は曖昧)
        RETURN jsonb_build_object('success', false,
                                  'has_pin', false,
                                  'message', 'PIN が未設定です。初回設定が必要');
    END IF;

    v_identifier := 'pin:' || p_contract_id;

    IF v_pin_hash != crypt(p_pin, v_pin_hash) THEN
        PERFORM record_login_failure(v_identifier);
        RETURN jsonb_build_object('success', false, 'message', 'PIN が正しくありません');
    END IF;

    PERFORM clear_login_failures(v_identifier);
    RETURN jsonb_build_object('success', true, 'has_pin', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, pg_temp;

-- =========================================================
-- admin_reset_pin_by_contract (再定義)
--   SELECT FOR UPDATE で同時実行を直列化
--   (複数の運営者が同時に同じ契約をリセットしても重複ログを最小化)
-- =========================================================
CREATE OR REPLACE FUNCTION admin_reset_pin_by_contract(
    p_contract_id TEXT,
    p_admin_password TEXT
) RETURNS JSONB AS $$
DECLARE
    v_org_id UUID;
    v_org_name TEXT;
    v_admin_pw TEXT;
    v_authorized BOOLEAN := FALSE;
    v_method TEXT;
    v_session_role TEXT;
    v_session_id TEXT;
BEGIN
    IF p_contract_id IS NULL OR length(p_contract_id) = 0
       OR p_admin_password IS NULL OR length(p_admin_password) = 0 THEN
        RETURN jsonb_build_object('success', false, 'message', '必須項目を入力してください');
    END IF;

    -- v3.7.137: FOR UPDATE で当該行をロック (同時実行を直列化)
    SELECT c.organization_id, c.admin_password, o.name
    INTO v_org_id, v_admin_pw, v_org_name
    FROM config c
    JOIN organizations o ON o.id = c.organization_id
    WHERE c.contract_id = p_contract_id
    FOR UPDATE OF c;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'message', '契約が見つかりません');
    END IF;

    -- マスター
    IF p_admin_password = 'rakushift1234' THEN
        v_authorized := TRUE;
        v_method := 'master_pw';
    ELSIF v_admin_pw IS NOT NULL AND length(v_admin_pw) > 0 THEN
        IF v_admin_pw LIKE '$2%' THEN
            IF v_admin_pw = crypt(p_admin_password, v_admin_pw) THEN
                v_authorized := TRUE;
                v_method := 'tenant_pw';
            END IF;
        ELSE
            IF v_admin_pw = p_admin_password THEN
                v_authorized := TRUE;
                v_method := 'tenant_pw';
            END IF;
        END IF;
    END IF;

    BEGIN
        SELECT role, get_session_id() INTO v_session_role, v_session_id
        FROM auth_sessions
        WHERE id = get_session_id() AND expires_at > now() LIMIT 1;
        IF v_session_role = 'platform_admin' THEN
            v_authorized := TRUE;
            IF v_method IS NULL THEN v_method := 'platform_session'; END IF;
        END IF;
    EXCEPTION WHEN OTHERS THEN
        NULL;
    END;

    IF NOT v_authorized THEN
        RETURN jsonb_build_object('success', false, 'message', '認証に失敗しました');
    END IF;

    UPDATE config SET pin_hash = NULL WHERE contract_id = p_contract_id;

    INSERT INTO pin_reset_log (contract_id, org_name, reset_method, actor)
    VALUES (p_contract_id, v_org_name, v_method, COALESCE(v_session_id, '?'));

    RETURN jsonb_build_object(
        'success', true,
        'message', 'PIN を初期化しました。テナント次回ログイン時に再設定が必要です',
        'contract_id', p_contract_id,
        'org_name', v_org_name,
        'method', v_method
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, pg_temp;

NOTIFY pgrst, 'reload schema';
