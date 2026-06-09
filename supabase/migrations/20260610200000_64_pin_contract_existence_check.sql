-- 64_pin_contract_existence_check.sql
-- ===========================================================
-- v3.7.135 CRITICAL SECURITY FIX:
--   set_pin_initial_by_contract が架空の契約 ID でも success=true を
--   返すバグを修正。同様に他の PIN RPC も「契約存在チェック」を統一。
--
-- 攻撃シナリオ (修正前):
--   1. 攻撃者がランダムな contract_id を推測 (15桁数字)
--   2. set_pin_initial_by_contract で「PIN 設定成功」と返るので、
--      存在する契約 ID を識別できてしまう
--   3. かつ pin_hash IS NULL の本物の契約があれば、攻撃者の PIN に
--      書き換えられ、初回ログイン時に攻撃者の PIN で侵入可能になる
--
-- 修正:
--   全ての pin 関連 RPC で「config に該当 contract_id が存在しないなら
--   success=false で同一メッセージを返す」(情報漏洩防止)
-- ===========================================================

-- =========================================================
-- set_pin_initial_by_contract (再定義)
--   契約存在チェック追加
-- =========================================================
CREATE OR REPLACE FUNCTION set_pin_initial_by_contract(
    p_contract_id TEXT,
    p_new_pin TEXT
) RETURNS JSONB AS $$
DECLARE
    v_exists BOOLEAN;
    v_current_hash TEXT;
    v_new_hash TEXT;
BEGIN
    IF p_contract_id IS NULL OR p_contract_id = '' THEN
        RETURN jsonb_build_object('success', false, 'message', '契約が見つかりません');
    END IF;
    IF p_new_pin IS NULL OR length(p_new_pin) < 4 OR length(p_new_pin) > 8 THEN
        RETURN jsonb_build_object('success', false, 'message', 'PIN は4〜8桁で入力してください');
    END IF;
    IF p_new_pin !~ '^[0-9]+$' THEN
        RETURN jsonb_build_object('success', false, 'message', 'PIN は数字のみ');
    END IF;

    -- 契約存在チェック (v3.7.135 セキュリティ修正)
    SELECT EXISTS(SELECT 1 FROM config WHERE contract_id = p_contract_id) INTO v_exists;
    IF NOT v_exists THEN
        RETURN jsonb_build_object('success', false, 'message', '契約が見つかりません');
    END IF;

    SELECT pin_hash INTO v_current_hash FROM config WHERE contract_id = p_contract_id;
    IF v_current_hash IS NOT NULL THEN
        RETURN jsonb_build_object('success', false,
                                  'message', 'PIN は既に設定済みです。変更は「PIN 変更」から');
    END IF;

    v_new_hash := crypt(p_new_pin, gen_salt('bf'));
    UPDATE config SET pin_hash = v_new_hash WHERE contract_id = p_contract_id;

    RETURN jsonb_build_object('success', true, 'message', 'PIN を設定しました');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, pg_temp;

GRANT EXECUTE ON FUNCTION set_pin_initial_by_contract(TEXT, TEXT) TO anon;

-- =========================================================
-- verify_pin_by_contract (再定義)
--   契約存在チェックを追加: 存在しない契約に対しては has_pin と
--   同じく「has_pin: false」を返すが、success: false にする
--   (= 架空 ID で「success: true」を返すと攻撃面が広がる)
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

    -- 契約存在チェック (v3.7.135)
    SELECT EXISTS(SELECT 1 FROM config WHERE contract_id = p_contract_id) INTO v_exists;
    IF NOT v_exists THEN
        RETURN jsonb_build_object('success', false, 'message', '契約が見つかりません');
    END IF;

    SELECT pin_hash INTO v_pin_hash FROM config WHERE contract_id = p_contract_id;
    IF v_pin_hash IS NULL THEN
        -- PIN 未設定 (= 初回設定が必要) → そのまま true (オプトイン経路維持)
        RETURN jsonb_build_object('success', true, 'has_pin', false);
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

GRANT EXECUTE ON FUNCTION verify_pin_by_contract(TEXT, TEXT) TO anon;

-- =========================================================
-- change_pin_with_pin_by_contract (再定義)
--   契約存在チェック追加
-- =========================================================
CREATE OR REPLACE FUNCTION change_pin_with_pin_by_contract(
    p_contract_id TEXT,
    p_current_pin TEXT,
    p_new_pin TEXT
) RETURNS JSONB AS $$
DECLARE
    v_exists BOOLEAN;
    v_pin_hash TEXT;
    v_new_hash TEXT;
    v_identifier TEXT;
BEGIN
    IF p_contract_id IS NULL OR p_contract_id = '' THEN
        RETURN jsonb_build_object('success', false, 'message', '契約が見つかりません');
    END IF;
    IF p_current_pin IS NULL OR length(p_current_pin) < 4 OR length(p_current_pin) > 8 THEN
        RETURN jsonb_build_object('success', false, 'message', '現在の PIN は4〜8桁');
    END IF;
    IF p_new_pin IS NULL OR length(p_new_pin) < 4 OR length(p_new_pin) > 8 THEN
        RETURN jsonb_build_object('success', false, 'message', '新しい PIN は4〜8桁');
    END IF;
    IF p_current_pin !~ '^[0-9]+$' OR p_new_pin !~ '^[0-9]+$' THEN
        RETURN jsonb_build_object('success', false, 'message', 'PIN は数字のみ');
    END IF;
    IF p_current_pin = p_new_pin THEN
        RETURN jsonb_build_object('success', false, 'message', '新しい PIN は現在の PIN と異なる値にしてください');
    END IF;

    -- 契約存在チェック (v3.7.135)
    SELECT EXISTS(SELECT 1 FROM config WHERE contract_id = p_contract_id) INTO v_exists;
    IF NOT v_exists THEN
        RETURN jsonb_build_object('success', false, 'message', '契約が見つかりません');
    END IF;

    SELECT pin_hash INTO v_pin_hash FROM config WHERE contract_id = p_contract_id;
    IF v_pin_hash IS NULL THEN
        RETURN jsonb_build_object('success', false,
                                  'message', 'PIN が未設定です。初回設定が必要');
    END IF;

    v_identifier := 'pin:' || p_contract_id;

    IF v_pin_hash != crypt(p_current_pin, v_pin_hash) THEN
        PERFORM record_login_failure(v_identifier);
        RETURN jsonb_build_object('success', false, 'message', '現在の PIN が正しくありません');
    END IF;

    v_new_hash := crypt(p_new_pin, gen_salt('bf'));
    UPDATE config SET pin_hash = v_new_hash WHERE contract_id = p_contract_id;
    PERFORM clear_login_failures(v_identifier);

    RETURN jsonb_build_object('success', true, 'message', 'PIN を変更しました');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, pg_temp;

GRANT EXECUTE ON FUNCTION change_pin_with_pin_by_contract(TEXT, TEXT, TEXT) TO anon;

NOTIFY pgrst, 'reload schema';
