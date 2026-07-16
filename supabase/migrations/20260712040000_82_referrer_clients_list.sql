-- =========================================================
-- 82_referrer_clients_list.sql
-- 目的: 「どの紹介者がどのクライアントを契約させたか」を運営が確認できるように。
--       課金状態に関わらず、紹介者コードが紐付いた全テナントを一覧で返す。
--       (既存 list_referrers の paying_count は課金中のみ数えるため、手動発行や
--        未課金の紹介先が 0 に見える = 反映されていないように見える問題への対応)
-- =========================================================

CREATE OR REPLACE FUNCTION list_referrer_clients()
RETURNS JSONB AS $$
DECLARE
    v_role TEXT;
BEGIN
    SELECT role INTO v_role FROM auth_sessions
    WHERE id = get_session_id() AND expires_at > now() LIMIT 1;
    IF v_role NOT IN ('hq_admin', 'platform_admin') THEN
        RAISE EXCEPTION 'Access denied.';
    END IF;

    RETURN COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
            'referrer_code', upper(trim(c.referrer_code)),
            'shop_name', o.name,
            'contract_id', c.contract_id,
            'plan', c.stripe_plan,
            'subscription_status', c.subscription_status,
            'license_status', COALESCE(o.license_status, 'active'),
            'is_paying', (c.subscription_status = 'active'),
            'created_at', o.created_at
        ) ORDER BY o.created_at DESC)
        FROM config c
        JOIN organizations o ON o.id = c.organization_id
        WHERE c.referrer_code IS NOT NULL AND trim(c.referrer_code) <> ''
    ), '[]'::jsonb);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, pg_temp;

GRANT EXECUTE ON FUNCTION list_referrer_clients() TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
