-- 65_admin_reset_pin.sql
-- ===========================================================
-- v3.7.136: 運営管理コンソールから PIN を初期化する RPC
--
-- 用途:
--   テナント管理者が PIN を忘れた、または引き継ぎで PIN が
--   分からなくなった場合に、運営管理者がリセットする。
--   初期化後、テナントは次回ログイン時に「初回設定モーダル」が
--   表示され、新しい PIN を設定できる。
--
-- 認証:
--   - マスターパスワード ('rakushift1234') または
--   - 該当テナントの admin_password (register_store_to_hq と同じ判定)
--   - もしくは platform_admin セッション
--
-- 監査:
--   - pin_reset_log テーブルに記録 (誰がいつどの contract をリセットしたか)
-- ===========================================================

-- =========================================================
-- pin_reset_log: 監査ログテーブル
-- =========================================================
CREATE TABLE IF NOT EXISTS pin_reset_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    contract_id TEXT NOT NULL,
    org_name TEXT,
    reset_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    reset_method TEXT NOT NULL,  -- 'master_pw' / 'tenant_pw' / 'platform_session'
    actor TEXT,                  -- 監査用 (session id 等)
    notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_pin_reset_log_contract ON pin_reset_log(contract_id);
CREATE INDEX IF NOT EXISTS idx_pin_reset_log_reset_at ON pin_reset_log(reset_at DESC);

ALTER TABLE pin_reset_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "pin_reset_log_no_access" ON pin_reset_log;
CREATE POLICY "pin_reset_log_no_access" ON pin_reset_log
    FOR ALL TO anon USING (false) WITH CHECK (false);
REVOKE ALL ON pin_reset_log FROM anon;

-- =========================================================
-- admin_reset_pin_by_contract(contract_id, admin_password)
--   テナントの pin_hash を NULL に戻す (=次回ログイン時に再設定必須)
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

    -- 1. contract_id → organization 解決
    SELECT c.organization_id, c.admin_password, o.name
    INTO v_org_id, v_admin_pw, v_org_name
    FROM config c
    JOIN organizations o ON o.id = c.organization_id
    WHERE c.contract_id = p_contract_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'message', '契約が見つかりません');
    END IF;

    -- 2. 認証 (マスター / テナントPW / platform セッション のいずれか)
    -- 2a. マスターパスワード
    IF p_admin_password = 'rakushift1234' THEN
        v_authorized := TRUE;
        v_method := 'master_pw';
    -- 2b. テナント自身の admin_password
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

    -- 2c. platform_admin セッションがあれば許可 (パスワードに関係なく)
    BEGIN
        SELECT role, get_session_id() INTO v_session_role, v_session_id
        FROM auth_sessions
        WHERE id = get_session_id() AND expires_at > now() LIMIT 1;
        IF v_session_role = 'platform_admin' THEN
            v_authorized := TRUE;
            IF v_method IS NULL THEN v_method := 'platform_session'; END IF;
        END IF;
    EXCEPTION WHEN OTHERS THEN
        -- セッション関数が無くてもエラーにしない
        NULL;
    END;

    IF NOT v_authorized THEN
        RETURN jsonb_build_object('success', false, 'message', '認証に失敗しました');
    END IF;

    -- 3. PIN を NULL に戻す
    UPDATE config SET pin_hash = NULL WHERE contract_id = p_contract_id;

    -- 4. 監査ログ
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

GRANT EXECUTE ON FUNCTION admin_reset_pin_by_contract(TEXT, TEXT) TO anon;

NOTIFY pgrst, 'reload schema';
