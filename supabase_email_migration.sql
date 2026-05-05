-- =========================================================
-- メール案内送信機能: customer_email列追加 + list_tenants更新
-- =========================================================

-- 1. configテーブルに顧客情報列を追加
ALTER TABLE config ADD COLUMN IF NOT EXISTS customer_email TEXT;
ALTER TABLE config ADD COLUMN IF NOT EXISTS contact_name TEXT;
ALTER TABLE config ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE config ADD COLUMN IF NOT EXISTS address TEXT;
ALTER TABLE config ADD COLUMN IF NOT EXISTS stripe_plan TEXT DEFAULT 'standard';
ALTER TABLE config ADD COLUMN IF NOT EXISTS payment_failed_at TIMESTAMPTZ;

-- 2. list_tenants関数を更新 (customer_email, stripe_planを含める)
CREATE OR REPLACE FUNCTION list_tenants()
RETURNS JSONB AS $$
BEGIN
    RETURN (
        SELECT jsonb_agg(
            jsonb_build_object(
                'organization_id', o.id,
                'name', o.name,
                'contract_id', c.contract_id,
                'license_status', COALESCE(o.license_status, 'active'),
                'license_suspended_at', o.license_suspended_at,
                'data_deletion_scheduled_at', o.data_deletion_scheduled_at,
                'license_note', COALESCE(o.license_note, ''),
                'subscription_status', COALESCE(c.subscription_status, 'free'),
                'stripe_plan', COALESCE(c.stripe_plan, 'free'),
                'stripe_customer_id', c.stripe_customer_id,
                'customer_email', c.customer_email,
                'contact_name', c.contact_name,
                'phone', c.phone,
                'address', c.address,
                'staff_count', (SELECT COUNT(*) FROM staff s WHERE s.organization_id = o.id),
                'created_at', o.created_at
            )
        )
        FROM organizations o
        LEFT JOIN config c ON c.organization_id = o.id
        ORDER BY o.created_at DESC
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
