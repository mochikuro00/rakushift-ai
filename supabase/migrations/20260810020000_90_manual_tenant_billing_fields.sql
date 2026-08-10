-- =========================================================
-- 90_manual_tenant_billing_fields.sql   (v3.7.286)
--
-- 手動発行テナントを、そのまま請求書払いの請求サイクルに乗せられるようにする。
--
-- 背景:
--   update_tenant_metadata の更新対象が固定リストで、
--     - company_name        (請求書の宛名になる正式な会社名)
--     - billing_email       (請求書の送付先)
--     - billing_start_date  (請求サイクルの起算日)
--     - payment_terms_days  (支払サイト)
--   が含まれておらず、手動発行では請求に必要な情報を保存できなかった。
--   特に company_name が保存されないため、請求書の宛名が店舗名になっていた。
-- =========================================================

CREATE OR REPLACE FUNCTION update_tenant_metadata(
    p_contract_id TEXT,
    p_data JSONB
) RETURNS JSONB AS $$
DECLARE
    v_role TEXT;
BEGIN
    SELECT role INTO v_role FROM auth_sessions
    WHERE id = get_session_id() AND expires_at > now() LIMIT 1;
    IF v_role NOT IN ('hq_admin', 'platform_admin') THEN
        RAISE EXCEPTION 'Access denied.';
    END IF;

    UPDATE config SET
        customer_email = COALESCE(p_data->>'customer_email', customer_email),
        contact_name   = COALESCE(p_data->>'contact_name', contact_name),
        phone          = COALESCE(p_data->>'phone', phone),
        contact_phone  = COALESCE(p_data->>'contact_phone', contact_phone),
        address        = COALESCE(p_data->>'address', address),
        referrer_code  = COALESCE(p_data->>'referrer_code', referrer_code),
        stripe_plan    = COALESCE(p_data->>'stripe_plan', stripe_plan),
        subscription_status = COALESCE(p_data->>'subscription_status', subscription_status),
        -- v3.7.286: 請求に必要な項目を追加
        company_name   = COALESCE(p_data->>'company_name', company_name),
        billing_email  = COALESCE(p_data->>'billing_email', billing_email),
        billing_note   = COALESCE(p_data->>'billing_note', billing_note),
        billing_start_date = COALESCE(
            CASE WHEN COALESCE(p_data->>'billing_start_date', '') = '' THEN NULL
                 ELSE (p_data->>'billing_start_date')::DATE END,
            billing_start_date),
        payment_terms_days = COALESCE(
            CASE WHEN COALESCE(p_data->>'payment_terms_days', '') = '' THEN NULL
                 ELSE (p_data->>'payment_terms_days')::INTEGER END,
            payment_terms_days)
    WHERE contract_id = p_contract_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'message', '契約IDが見つかりません');
    END IF;
    RETURN jsonb_build_object('success', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, pg_temp;

GRANT EXECUTE ON FUNCTION update_tenant_metadata(TEXT, JSONB) TO anon, authenticated;


-- =========================================================
-- 手動発行テナントの請求開始日を必ず持たせる
--   ビュー側で organizations.created_at にフォールバックしているが、
--   運営が起算日を後から変えられるよう実列にも入れておく。
-- =========================================================
UPDATE config c
   SET billing_start_date = o.created_at::DATE
  FROM organizations o
 WHERE o.id = c.organization_id
   AND c.billing_start_date IS NULL;

ALTER TABLE config ALTER COLUMN billing_start_date SET DEFAULT CURRENT_DATE;

NOTIFY pgrst, 'reload schema';
