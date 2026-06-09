-- 62_optin_pin.sql
-- ===========================================================
-- v3.7.133: オプトイン PIN (店舗管理者のセカンドファクター)
--
-- 目的:
--   contract_id 単一認証への補強として、希望ユーザーが4-8桁の PIN を
--   設定できるようにする。未設定 (=NULL) ユーザーは従来通り。
--
-- 設計:
--   - config.pin_hash TEXT NULL (bcryptハッシュ)
--   - 既存ユーザーは NULL のままで影響なし (オプトイン)
--   - PIN は ログイン成功後 に検証 (パスワードの後段の追加チェック)
--   - 失敗試行は既存の login_attempts (migration 26) で同様にレート制限
--
-- 提供 RPC:
--   - has_pin_by_contract(contract_id) → {has_pin: bool}
--     ※ PIN 設定有無のみ返す。Hash や salt は決して返さない
--   - verify_pin_by_contract(contract_id, pin) → {success, message}
--     ※ 失敗時は can_attempt_login / record_login_failure と連携
--   - set_pin_by_contract(contract_id, current_password, new_pin) → {success, message}
--     ※ パスワード再確認必須。新規設定/変更の両用
--   - clear_pin_by_contract(contract_id, current_password) → {success, message}
--     ※ パスワード再確認必須。PIN を解除して NULL に戻す
--
-- セキュリティ:
--   - すべて SECURITY DEFINER で search_path 固定
--   - anon の SELECT/UPDATE/DELETE は RLS で遮断、INSERT は config 由来のみ
-- ===========================================================

ALTER TABLE config
    ADD COLUMN IF NOT EXISTS pin_hash TEXT DEFAULT NULL;

COMMENT ON COLUMN config.pin_hash IS
    'オプトイン PIN の bcrypt ハッシュ。NULL=未設定 (従来通りのログイン)。
     設定すると ログイン成功後に追加の PIN 検証が必要';

-- =========================================================
-- has_pin_by_contract(contract_id)
--   PIN が設定されているか確認 (hash は返さない)
-- =========================================================
CREATE OR REPLACE FUNCTION has_pin_by_contract(p_contract_id TEXT)
RETURNS JSONB AS $$
DECLARE
    v_pin_hash TEXT;
BEGIN
    IF p_contract_id IS NULL OR p_contract_id = '' THEN
        RETURN jsonb_build_object('has_pin', false);
    END IF;

    SELECT pin_hash INTO v_pin_hash FROM config WHERE contract_id = p_contract_id;
    RETURN jsonb_build_object('has_pin', v_pin_hash IS NOT NULL);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, pg_temp;

GRANT EXECUTE ON FUNCTION has_pin_by_contract(TEXT) TO anon;

-- =========================================================
-- verify_pin_by_contract(contract_id, pin)
--   PIN を検証 (失敗時は login_attempts にカウント)
-- =========================================================
CREATE OR REPLACE FUNCTION verify_pin_by_contract(
    p_contract_id TEXT,
    p_pin TEXT
) RETURNS JSONB AS $$
DECLARE
    v_pin_hash TEXT;
    v_identifier TEXT;
BEGIN
    IF p_contract_id IS NULL OR p_contract_id = '' THEN
        RETURN jsonb_build_object('success', false, 'message', 'contract_id is required');
    END IF;
    IF p_pin IS NULL OR length(p_pin) < 4 OR length(p_pin) > 8 THEN
        RETURN jsonb_build_object('success', false, 'message', 'PIN は4〜8桁で入力してください');
    END IF;

    -- 数字のみチェック
    IF p_pin !~ '^[0-9]+$' THEN
        RETURN jsonb_build_object('success', false, 'message', 'PIN は数字のみ');
    END IF;

    SELECT pin_hash INTO v_pin_hash FROM config WHERE contract_id = p_contract_id;
    IF v_pin_hash IS NULL THEN
        -- PIN 未設定。検証成功とみなす (オプトイン)
        RETURN jsonb_build_object('success', true, 'has_pin', false);
    END IF;

    v_identifier := 'pin:' || p_contract_id;

    IF v_pin_hash != crypt(p_pin, v_pin_hash) THEN
        -- 失敗を記録
        PERFORM record_login_failure(v_identifier);
        RETURN jsonb_build_object('success', false, 'message', 'PIN が正しくありません');
    END IF;

    -- 成功時はカウンタリセット
    PERFORM clear_login_failures(v_identifier);
    RETURN jsonb_build_object('success', true, 'has_pin', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, pg_temp;

GRANT EXECUTE ON FUNCTION verify_pin_by_contract(TEXT, TEXT) TO anon;

-- =========================================================
-- set_pin_by_contract(contract_id, current_password, new_pin)
--   PIN を設定/変更 (現在のパスワード確認必須)
-- =========================================================
CREATE OR REPLACE FUNCTION set_pin_by_contract(
    p_contract_id TEXT,
    p_current_password TEXT,
    p_new_pin TEXT
) RETURNS JSONB AS $$
DECLARE
    v_shop_password TEXT;
    v_new_hash TEXT;
BEGIN
    IF p_contract_id IS NULL OR p_contract_id = '' THEN
        RETURN jsonb_build_object('success', false, 'message', 'contract_id is required');
    END IF;
    IF p_current_password IS NULL OR p_current_password = '' THEN
        RETURN jsonb_build_object('success', false, 'message', '現在のパスワードを入力してください');
    END IF;
    IF p_new_pin IS NULL OR length(p_new_pin) < 4 OR length(p_new_pin) > 8 THEN
        RETURN jsonb_build_object('success', false, 'message', 'PIN は4〜8桁で入力してください');
    END IF;
    IF p_new_pin !~ '^[0-9]+$' THEN
        RETURN jsonb_build_object('success', false, 'message', 'PIN は数字のみ');
    END IF;

    SELECT shop_password INTO v_shop_password FROM config WHERE contract_id = p_contract_id;
    IF v_shop_password IS NULL THEN
        RETURN jsonb_build_object('success', false, 'message', '契約が見つかりません');
    END IF;

    IF v_shop_password != crypt(p_current_password, v_shop_password) THEN
        RETURN jsonb_build_object('success', false, 'message', '現在のパスワードが正しくありません');
    END IF;

    v_new_hash := crypt(p_new_pin, gen_salt('bf'));
    UPDATE config SET pin_hash = v_new_hash WHERE contract_id = p_contract_id;

    RETURN jsonb_build_object('success', true, 'message', 'PIN を設定しました');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, pg_temp;

GRANT EXECUTE ON FUNCTION set_pin_by_contract(TEXT, TEXT, TEXT) TO anon;

-- =========================================================
-- clear_pin_by_contract(contract_id, current_password)
--   PIN を解除 (現在のパスワード確認必須)
-- =========================================================
CREATE OR REPLACE FUNCTION clear_pin_by_contract(
    p_contract_id TEXT,
    p_current_password TEXT
) RETURNS JSONB AS $$
DECLARE
    v_shop_password TEXT;
BEGIN
    IF p_contract_id IS NULL OR p_contract_id = '' THEN
        RETURN jsonb_build_object('success', false, 'message', 'contract_id is required');
    END IF;
    IF p_current_password IS NULL OR p_current_password = '' THEN
        RETURN jsonb_build_object('success', false, 'message', '現在のパスワードを入力してください');
    END IF;

    SELECT shop_password INTO v_shop_password FROM config WHERE contract_id = p_contract_id;
    IF v_shop_password IS NULL THEN
        RETURN jsonb_build_object('success', false, 'message', '契約が見つかりません');
    END IF;

    IF v_shop_password != crypt(p_current_password, v_shop_password) THEN
        RETURN jsonb_build_object('success', false, 'message', '現在のパスワードが正しくありません');
    END IF;

    UPDATE config SET pin_hash = NULL WHERE contract_id = p_contract_id;

    RETURN jsonb_build_object('success', true, 'message', 'PIN を解除しました');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, pg_temp;

GRANT EXECUTE ON FUNCTION clear_pin_by_contract(TEXT, TEXT) TO anon;

NOTIFY pgrst, 'reload schema';
