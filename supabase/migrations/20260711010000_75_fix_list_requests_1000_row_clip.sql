-- =========================================================
-- 75_fix_list_requests_1000_row_clip.sql
-- 目的: 申請リストも migration 74 と同様に PostgREST の max-rows=1000 で
--       切り捨てられる潜在バグを解消 (スケール対応)。
--       created_at DESC 順のため切れるのは古い申請だが、件数が多い店舗で
--       全件参照が壊れるのを防ぐ。JSONB 一括返しで行数制限を回避。
-- =========================================================

DROP FUNCTION IF EXISTS list_requests_by_contract(TEXT);
CREATE OR REPLACE FUNCTION list_requests_by_contract(p_contract_id TEXT)
RETURNS JSONB AS $$
DECLARE v_org_id UUID;
BEGIN
    SELECT organization_id INTO v_org_id FROM config WHERE contract_id = p_contract_id;
    IF v_org_id IS NULL THEN RETURN '[]'::jsonb; END IF;
    RETURN COALESCE((
        SELECT jsonb_agg(to_jsonb(r) ORDER BY r.created_at DESC)
        FROM requests r
        WHERE r.organization_id = v_org_id
    ), '[]'::jsonb);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, extensions, pg_temp;
GRANT EXECUTE ON FUNCTION list_requests_by_contract(TEXT) TO anon;

NOTIFY pgrst, 'reload schema';
