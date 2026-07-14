-- =========================================================
-- 80_hq_shops_license_status.sql
-- 目的: 本部ダッシュボードの店舗一覧に「稼働中/停止」を正しく表示する。
--       hq_get_all_shops が license_status を返しておらず、v3.7.244 で
--       データ取得をこの RPC に一本化して以降、常に「稼働中」表示になっていた。
-- =========================================================

DROP FUNCTION IF EXISTS hq_get_all_shops();
CREATE OR REPLACE FUNCTION hq_get_all_shops()
RETURNS JSONB AS $$
DECLARE
    v_scope UUID[];
BEGIN
    IF COALESCE(get_session_role(), '') != 'hq_admin' THEN
        RAISE EXCEPTION 'Access denied.';
    END IF;

    v_scope := get_hq_scope();

    RETURN COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
            'organization_id', o.id,
            'name', o.name,
            'contract_id', c.contract_id,
            'plan', c.stripe_plan,
            'staff_count', (SELECT COUNT(*) FROM staff s WHERE s.organization_id = o.id),
            'license_status', COALESCE(o.license_status, 'active'),
            'created_at', o.created_at
        ) ORDER BY o.created_at DESC)
        FROM organizations o
        JOIN config c ON o.id = c.organization_id
        WHERE v_scope IS NULL OR o.id = ANY(v_scope)
    ), '[]'::jsonb);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, pg_temp;

GRANT EXECUTE ON FUNCTION hq_get_all_shops() TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
