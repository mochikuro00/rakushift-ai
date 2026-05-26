-- 49_get_config_by_contract.sql
-- ===========================================================
-- 設定 (config) を contract_id だけで読み出す session-less RPC。
-- migration 46 は id/org_id のみ返したが、本 RPC は config_safe view
-- 相当の全列を返す。loadData が REST → RPC の二段経由をやめて
-- 単一 RPC で完結できるようにする。
-- ===========================================================

CREATE OR REPLACE FUNCTION get_config_by_contract(p_contract_id TEXT)
RETURNS JSONB AS $$
DECLARE v_row JSONB;
BEGIN
    IF p_contract_id IS NULL OR p_contract_id = '' THEN
        RETURN NULL;
    END IF;

    SELECT to_jsonb(c) - 'shop_password' - 'admin_password' - 'gemini_api_key' - 'openai_api_key'
        || jsonb_build_object(
            'license_status', o.license_status,
            'license_suspended_at', o.license_suspended_at
        )
    INTO v_row
    FROM config c
    LEFT JOIN organizations o ON o.id = c.organization_id
    WHERE c.contract_id = p_contract_id;

    RETURN v_row;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, pg_temp;

GRANT EXECUTE ON FUNCTION get_config_by_contract(TEXT) TO anon;

NOTIFY pgrst, 'reload schema';
