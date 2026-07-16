-- =========================================================
-- 85_config_company_name.sql
-- 目的: 会社名を DB に確実に保持し、顧客情報・紹介者クライアント一覧に必ず表示する。
--       organizations.name は店舗側が後から変更できるため、申込時の会社名を config に
--       別途保存する。既存テナントは現時点の organizations.name で埋める(バックフィル)。
-- =========================================================

ALTER TABLE config
    ADD COLUMN IF NOT EXISTS company_name TEXT;

COMMENT ON COLUMN config.company_name IS '申込時の会社名 (organizations.name とは独立に保持)';

-- 既存テナント: 空なら現在の組織名で埋める
UPDATE config c
SET company_name = o.name
FROM organizations o
WHERE o.id = c.organization_id
  AND (c.company_name IS NULL OR c.company_name = '');

-- 紹介者クライアント一覧に会社名を含める
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
            'company_name', COALESCE(NULLIF(c.company_name, ''), o.name),
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
