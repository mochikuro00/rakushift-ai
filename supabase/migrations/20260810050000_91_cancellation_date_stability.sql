-- =========================================================
-- 91_cancellation_date_stability.sql   (v3.7.286)
--
-- 解約者台帳が毎日増え続ける不具合の修正。
--
-- 誤:
--   sync_cancellations は解約日を
--     COALESCE(解約発効日, 解約申請日, 今日)
--   で決めていた。未払いによるライセンス停止など「解約発効日も申請日も無い」
--   テナントでは毎回「今日」になるため、一意キー(contract_id, cancelled_on)が
--   日ごとに変わり、同期のたびに新しい解約行が増えていた。
--
-- 正:
--   ライセンス停止日時 (organizations.license_suspended_at) を使う。
--   それも無い場合は日付が確定できないので記録をスキップする
--   (毎日ぶれる日付で記録するくらいなら、記録しない方が台帳が壊れない)。
-- =========================================================

-- 顧客台帳ビューに停止日時を出す
DROP VIEW IF EXISTS v_customer_ledger CASCADE;
CREATE VIEW v_customer_ledger AS
SELECT
    o.id                                    AS organization_id,
    c.contract_id,
    o.name                                  AS shop_name,
    COALESCE(c.company_name, '')            AS company_name,
    COALESCE(c.contact_name, '')            AS contact_name,
    COALESCE(NULLIF(trim(c.billing_email), ''),
             NULLIF(trim(c.customer_email), ''),
             NULLIF(trim(c.contact_email), ''),
             '')                            AS billing_email,
    COALESCE(c.phone, '')                   AS phone,
    COALESCE(c.contact_phone, '')           AS contact_phone,
    COALESCE(c.address, '')                 AS address,
    CASE
        WHEN c.stripe_subscription_id IS NOT NULL THEN 'stripe'
        WHEN lower(COALESCE(c.stripe_plan, '')) IN ('oem', 'enterprise') THEN 'oem'
        ELSE 'invoice'
    END                                     AS billing_category,
    COALESCE(c.stripe_plan, '')             AS plan,
    get_plan_price(c.stripe_plan)           AS monthly_amount,
    upper(trim(COALESCE(c.referrer_code, ''))) AS referrer_code,
    COALESCE(r.name, '')                    AS referrer_name,
    COALESCE(c.agency_fee_type, 'inherit')  AS agency_fee_type,
    COALESCE(c.agency_fee_amount, 0)        AS agency_fee_amount,
    resolve_agency_fee(c.referrer_code, c.stripe_plan, c.agency_fee_type,
                       c.agency_fee_amount, get_plan_price(c.stripe_plan))
                                            AS agency_fee_monthly,
    COALESCE(c.subscription_status, '')     AS subscription_status,
    COALESCE(o.license_status, 'active')    AS license_status,
    o.license_suspended_at,
    c.cancel_requested_at,
    c.cancel_effective_date,
    COALESCE(c.payment_terms_days, 10)      AS payment_terms_days,
    COALESCE(c.billing_start_date, o.created_at::DATE) AS billing_start_date,
    COALESCE(c.billing_note, '')            AS billing_note,
    o.created_at,
    inv.last_invoice_month,
    inv.last_period_end,
    inv.unpaid_count,
    inv.unpaid_amount,
    inv.paid_total,
    inv.last_paid_at
FROM config c
JOIN organizations o ON o.id = c.organization_id
LEFT JOIN referrers r ON upper(trim(r.code)) = upper(trim(c.referrer_code))
LEFT JOIN LATERAL (
    SELECT
        max(i.billing_month)                                                   AS last_invoice_month,
        max(i.period_end)                                                      AS last_period_end,
        count(*) FILTER (WHERE i.status IN ('issued', 'sent', 'partial'))       AS unpaid_count,
        COALESCE(sum(i.total - i.paid_amount)
                 FILTER (WHERE i.status IN ('issued', 'sent', 'partial')), 0)   AS unpaid_amount,
        COALESCE(sum(i.paid_amount), 0)                                         AS paid_total,
        max(i.paid_at)                                                          AS last_paid_at
    FROM invoices i
    WHERE i.organization_id = o.id AND i.status <> 'void'
) inv ON TRUE;

REVOKE ALL ON TABLE v_customer_ledger FROM anon, authenticated;
GRANT SELECT ON TABLE v_customer_ledger TO service_role;


CREATE OR REPLACE FUNCTION sync_cancellations()
RETURNS JSONB AS $$
DECLARE
    rec RECORD;
    n INTEGER := 0;
    skipped INTEGER := 0;
BEGIN
    FOR rec IN
        SELECT contract_id,
               -- 日付は「動かない値」だけを使う。今日を使うと毎日別の行になる。
               COALESCE(cancel_effective_date,
                        (cancel_requested_at AT TIME ZONE 'Asia/Tokyo')::DATE,
                        (license_suspended_at AT TIME ZONE 'Asia/Tokyo')::DATE) AS eff
          FROM v_customer_ledger
         WHERE license_status = 'suspended'
            OR subscription_status = 'canceled'
            OR cancel_requested_at IS NOT NULL
    LOOP
        IF rec.eff IS NULL THEN
            skipped := skipped + 1;   -- 解約日が確定できないものは記録しない
            CONTINUE;
        END IF;
        PERFORM record_cancellation(rec.contract_id, rec.eff, '');
        n := n + 1;
    END LOOP;
    RETURN jsonb_build_object('success', true, 'synced', n, 'skipped_no_date', skipped);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp;


-- =========================================================
-- 解約行は「1顧客1行」に統一する。
--
-- 一意キーを (contract_id, cancelled_on) にしていたため、
-- 先に停止日で記録された後から正式な解約発効日が入ると、
-- 日付違いの行が2件並んでしまっていた。
-- 解約日は後から確定・訂正されうるので、契約IDだけを一意キーにして
-- 最新の内容で上書きする。
-- =========================================================
DELETE FROM cancellations a
 USING cancellations b
 WHERE a.contract_id = b.contract_id
   AND a.contract_id <> ''
   AND (a.recorded_at, a.id) < (b.recorded_at, b.id);

DROP INDEX IF EXISTS uq_cancellations_contract_date;
CREATE UNIQUE INDEX IF NOT EXISTS uq_cancellations_contract
    ON cancellations(contract_id) WHERE contract_id <> '';

CREATE OR REPLACE FUNCTION record_cancellation(
    p_contract_id TEXT,
    p_cancelled_on DATE DEFAULT NULL,
    p_reason TEXT DEFAULT ''
) RETURNS JSONB AS $$
DECLARE
    c        RECORD;
    v_end    DATE := COALESCE(p_cancelled_on, (now() AT TIME ZONE 'Asia/Tokyo')::DATE);
    v_start  DATE;
    v_days   INTEGER;
    v_months NUMERIC(6,1);
    v_early_m INTEGER;
    v_refund NUMERIC(12,2);
BEGIN
    SELECT * INTO c FROM v_customer_ledger WHERE contract_id = p_contract_id LIMIT 1;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'contract_id', p_contract_id,
                                  'message', '契約IDが見つかりません');
    END IF;

    v_start := COALESCE(c.billing_start_date, c.created_at::DATE);
    v_days  := GREATEST((v_end - v_start), 0);
    v_months := ROUND(v_days / 30.4375::NUMERIC, 1);

    SELECT COALESCE(value, '6')::INTEGER INTO v_early_m
      FROM platform_settings WHERE key = 'early_churn_months';
    v_early_m := COALESCE(v_early_m, 6);

    SELECT COALESCE(sum(amount), 0) INTO v_refund
      FROM refunds WHERE contract_id = p_contract_id;

    INSERT INTO cancellations (
        organization_id, contract_id, shop_name, company_name, contact_name, email, phone, address,
        plan, billing_category, monthly_amount, referrer_code,
        started_on, cancel_requested_at, cancelled_on, contract_days, contract_months, is_early_churn,
        total_billed, total_paid, total_refunded, reason
    ) VALUES (
        c.organization_id, c.contract_id, c.shop_name, c.company_name, c.contact_name,
        c.billing_email, COALESCE(NULLIF(c.phone, ''), c.contact_phone), c.address,
        c.plan, c.billing_category, c.monthly_amount, c.referrer_code,
        v_start, c.cancel_requested_at, v_end, v_days, v_months,
        (v_months < v_early_m),
        COALESCE(c.unpaid_amount, 0) + COALESCE(c.paid_total, 0), COALESCE(c.paid_total, 0),
        v_refund, COALESCE(p_reason, '')
    )
    ON CONFLICT (contract_id) WHERE contract_id <> '' DO UPDATE SET
        cancelled_on = EXCLUDED.cancelled_on,
        cancel_requested_at = EXCLUDED.cancel_requested_at,
        contract_days = EXCLUDED.contract_days,
        contract_months = EXCLUDED.contract_months,
        is_early_churn = EXCLUDED.is_early_churn,
        total_billed = EXCLUDED.total_billed,
        total_paid = EXCLUDED.total_paid,
        total_refunded = EXCLUDED.total_refunded,
        -- 顧客情報は解約時点のものを保ちたいが、空だった項目は後から埋める
        company_name = COALESCE(NULLIF(cancellations.company_name, ''), EXCLUDED.company_name),
        email        = COALESCE(NULLIF(cancellations.email, ''), EXCLUDED.email),
        phone        = COALESCE(NULLIF(cancellations.phone, ''), EXCLUDED.phone),
        address      = COALESCE(NULLIF(cancellations.address, ''), EXCLUDED.address),
        reason = CASE WHEN EXCLUDED.reason = '' THEN cancellations.reason ELSE EXCLUDED.reason END,
        recorded_at = now();

    RETURN jsonb_build_object('success', true, 'contract_id', p_contract_id,
                              'contract_days', v_days, 'contract_months', v_months,
                              'is_early_churn', (v_months < v_early_m));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp;

REVOKE EXECUTE ON FUNCTION record_cancellation(TEXT, DATE, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION record_cancellation(TEXT, DATE, TEXT) TO service_role;

REVOKE EXECUTE ON FUNCTION sync_cancellations() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION sync_cancellations() TO service_role;

NOTIFY pgrst, 'reload schema';
