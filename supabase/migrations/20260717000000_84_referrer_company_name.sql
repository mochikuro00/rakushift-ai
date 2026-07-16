-- =========================================================
-- 84_referrer_company_name.sql
-- 目的: 紹介者の新規発行に「紹介法人名」を記録できるようにする。
--       (紹介者が所属/代表する法人名など)
-- =========================================================

ALTER TABLE referrers
    ADD COLUMN IF NOT EXISTS company_name TEXT DEFAULT '';

COMMENT ON COLUMN referrers.company_name IS '紹介法人名 (紹介者が所属/代表する法人)';

-- create_referrer に p_company_name を追加
CREATE OR REPLACE FUNCTION create_referrer(
    p_name TEXT,
    p_code TEXT DEFAULT NULL,
    p_email TEXT DEFAULT '',
    p_phone TEXT DEFAULT '',
    p_commission_rate NUMERIC DEFAULT 30.00,
    p_commission_amount NUMERIC DEFAULT 0,
    p_commission_type TEXT DEFAULT 'percent',
    p_note TEXT DEFAULT '',
    p_bank_account TEXT DEFAULT '',
    p_company_name TEXT DEFAULT ''
) RETURNS JSONB AS $$
DECLARE
    new_code TEXT;
    new_id UUID;
BEGIN
    IF p_code IS NULL OR p_code = '' THEN
        LOOP
            new_code := 'REF' || upper(substring(md5(random()::text || clock_timestamp()::text), 1, 8));
            EXIT WHEN NOT EXISTS (SELECT 1 FROM referrers WHERE code = new_code);
        END LOOP;
    ELSE
        new_code := upper(p_code);
        IF EXISTS (SELECT 1 FROM referrers WHERE code = new_code) THEN
            RETURN jsonb_build_object('success', false, 'message', 'このコードは既に使用されています');
        END IF;
    END IF;

    INSERT INTO referrers (code, name, email, phone, commission_rate, commission_amount, commission_type, note, bank_account, company_name)
    VALUES (new_code, p_name, p_email, p_phone, p_commission_rate, p_commission_amount, p_commission_type, p_note, p_bank_account, p_company_name)
    RETURNING id INTO new_id;

    RETURN jsonb_build_object('success', true, 'id', new_id, 'code', new_code, 'name', p_name);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- update_referrer に p_company_name を追加
CREATE OR REPLACE FUNCTION update_referrer(
    p_id UUID,
    p_name TEXT DEFAULT NULL,
    p_email TEXT DEFAULT NULL,
    p_phone TEXT DEFAULT NULL,
    p_commission_rate NUMERIC DEFAULT NULL,
    p_commission_amount NUMERIC DEFAULT NULL,
    p_commission_type TEXT DEFAULT NULL,
    p_active BOOLEAN DEFAULT NULL,
    p_note TEXT DEFAULT NULL,
    p_bank_account TEXT DEFAULT NULL,
    p_company_name TEXT DEFAULT NULL
) RETURNS JSONB AS $$
BEGIN
    UPDATE referrers
    SET name = COALESCE(p_name, name),
        email = COALESCE(p_email, email),
        phone = COALESCE(p_phone, phone),
        commission_rate = COALESCE(p_commission_rate, commission_rate),
        commission_amount = COALESCE(p_commission_amount, commission_amount),
        commission_type = COALESCE(p_commission_type, commission_type),
        active = COALESCE(p_active, active),
        note = COALESCE(p_note, note),
        bank_account = COALESCE(p_bank_account, bank_account),
        company_name = COALESCE(p_company_name, company_name),
        updated_at = now()
    WHERE id = p_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'message', '紹介者が見つかりません');
    END IF;

    RETURN jsonb_build_object('success', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- list_referrers に company_name / bank_account を含める (編集フォームの復元用)
CREATE OR REPLACE FUNCTION list_referrers()
RETURNS JSONB AS $$
BEGIN
    RETURN (
        SELECT COALESCE(jsonb_agg(
            jsonb_build_object(
                'id', r.id,
                'code', r.code,
                'name', r.name,
                'company_name', COALESCE(r.company_name, ''),
                'bank_account', COALESCE(r.bank_account, ''),
                'email', r.email,
                'phone', r.phone,
                'commission_type', COALESCE(r.commission_type, 'percent'),
                'commission_rate', r.commission_rate,
                'commission_amount', COALESCE(r.commission_amount, 0),
                'active', r.active,
                'note', r.note,
                'created_at', r.created_at,
                'tenant_count', stats.tenant_count,
                'paying_count', stats.paying_count,
                'oem_count', stats.oem_count,
                'monthly_revenue', stats.monthly_revenue,
                'oem_revenue', stats.oem_revenue,
                'monthly_commission',
                    (stats.oem_count * 3200) +
                    CASE COALESCE(r.commission_type, 'percent')
                        WHEN 'fixed' THEN ROUND(stats.paying_count * COALESCE(r.commission_amount, 0))
                        ELSE ROUND(stats.monthly_revenue * COALESCE(r.commission_rate, 0) / 100)
                    END
            )
            ORDER BY r.created_at DESC
        ), '[]'::jsonb)
        FROM referrers r
        LEFT JOIN LATERAL (
            SELECT
                COUNT(*) AS tenant_count,
                COUNT(*) FILTER (WHERE c.subscription_status = 'active' AND c.stripe_customer_id IS NOT NULL AND c.stripe_plan != 'oem') AS paying_count,
                COUNT(*) FILTER (WHERE c.stripe_plan = 'oem' AND c.subscription_status = 'active') AS oem_count,
                COALESCE(SUM(
                    CASE
                        WHEN c.stripe_plan != 'oem' AND c.subscription_status = 'active' AND c.stripe_customer_id IS NOT NULL THEN
                            CASE c.stripe_plan
                                WHEN 'standard' THEN 3380
                                WHEN 'pro' THEN 4880
                                WHEN 'premium' THEN 9980
                                ELSE 0
                            END
                        ELSE 0
                    END
                ), 0) AS monthly_revenue,
                COALESCE(SUM(
                    CASE WHEN c.stripe_plan = 'oem' AND c.subscription_status = 'active' THEN 4000 ELSE 0 END
                ), 0) AS oem_revenue
            FROM config c
            WHERE c.referrer_code = r.code
        ) stats ON TRUE
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION create_referrer(TEXT,TEXT,TEXT,TEXT,NUMERIC,NUMERIC,TEXT,TEXT,TEXT,TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION update_referrer(UUID,TEXT,TEXT,TEXT,NUMERIC,NUMERIC,TEXT,BOOLEAN,TEXT,TEXT,TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION list_referrers() TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
