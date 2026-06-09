-- 63_pin_mandatory.sql
-- ===========================================================
-- v3.7.134: PIN を必須化 + 既存テナントも初回ログイン時に強制設定
--
-- 変更:
--   - 初回設定用 RPC: pin_hash が NULL のときのみ動作する set_pin_initial
--   - PIN 変更用 RPC: 現 PIN で認証して新 PIN に変更する change_pin_with_pin
--   - 既存の set_pin_by_contract (パスワード認証) は緊急対応用に残置
--   - 既存の clear_pin_by_contract (パスワード認証) は緊急対応用に残置
--
-- 仕様:
--   - 初回設定は キャンセル不可 (フロント側で強制)
--   - PIN は 4〜8桁の数字のみ
--   - 連続失敗は login_attempts (migration 26) で同様にカウント
-- ===========================================================

-- =========================================================
-- set_pin_initial_by_contract(contract_id, new_pin)
--   pin_hash が NULL のスタッフのみ動作 (= 初回設定専用)
-- =========================================================
CREATE OR REPLACE FUNCTION set_pin_initial_by_contract(
    p_contract_id TEXT,
    p_new_pin TEXT
) RETURNS JSONB AS $$
DECLARE
    v_current_hash TEXT;
    v_new_hash TEXT;
BEGIN
    IF p_contract_id IS NULL OR p_contract_id = '' THEN
        RETURN jsonb_build_object('success', false, 'message', 'contract_id is required');
    END IF;
    IF p_new_pin IS NULL OR length(p_new_pin) < 4 OR length(p_new_pin) > 8 THEN
        RETURN jsonb_build_object('success', false, 'message', 'PIN は4〜8桁で入力してください');
    END IF;
    IF p_new_pin !~ '^[0-9]+$' THEN
        RETURN jsonb_build_object('success', false, 'message', 'PIN は数字のみ');
    END IF;

    -- 既に PIN が設定されている場合は拒否
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
-- change_pin_with_pin_by_contract(contract_id, current_pin, new_pin)
--   現 PIN で認証して新 PIN に変更 (引き継ぎ時の標準手順)
-- =========================================================
CREATE OR REPLACE FUNCTION change_pin_with_pin_by_contract(
    p_contract_id TEXT,
    p_current_pin TEXT,
    p_new_pin TEXT
) RETURNS JSONB AS $$
DECLARE
    v_pin_hash TEXT;
    v_new_hash TEXT;
    v_identifier TEXT;
BEGIN
    IF p_contract_id IS NULL OR p_contract_id = '' THEN
        RETURN jsonb_build_object('success', false, 'message', 'contract_id is required');
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
