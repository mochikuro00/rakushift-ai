-- =========================================================
-- 74_fix_list_shifts_1000_row_clip.sql
-- 目的: シフト表が「途中の日付から表示されない」バグの修正。
--
-- 原因: list_shifts_by_contract が RETURNS SETOF shifts (行返し) のため、
--       Supabase(PostgREST) の max-rows=1000 制限が適用され、date 昇順の
--       先頭1000行で切り捨てられていた。データ量が増えたテナントでは
--       読み込み範囲(±3ヶ月)の後半日付がフロントに渡らず表示されない。
--
-- 修正: JSONB (jsonb_agg) の単一値で返す。単一JSONB値には行数制限が
--       適用されないため全件返る。フロントは配列を受ける形のままで互換。
-- =========================================================

DROP FUNCTION IF EXISTS list_shifts_by_contract(TEXT, TEXT, TEXT);
CREATE OR REPLACE FUNCTION list_shifts_by_contract(
    p_contract_id TEXT,
    p_from TEXT DEFAULT NULL,
    p_to TEXT DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE v_org_id UUID;
BEGIN
    SELECT organization_id INTO v_org_id FROM config WHERE contract_id = p_contract_id;
    IF v_org_id IS NULL THEN RETURN '[]'::jsonb; END IF;
    RETURN COALESCE((
        SELECT jsonb_agg(to_jsonb(s) ORDER BY s.date, s.start_time)
        FROM shifts s
        WHERE s.organization_id = v_org_id
          AND (p_from IS NULL OR s.date >= p_from::DATE)
          AND (p_to IS NULL OR s.date <= p_to::DATE)
    ), '[]'::jsonb);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, extensions, pg_temp;
GRANT EXECUTE ON FUNCTION list_shifts_by_contract(TEXT, TEXT, TEXT) TO anon;

NOTIFY pgrst, 'reload schema';
