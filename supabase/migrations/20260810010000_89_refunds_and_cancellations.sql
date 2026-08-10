-- =========================================================
-- 89_refunds_and_cancellations.sql   (v3.7.286)
--
-- 1) 返金台帳
--    Stripe の返金 (テスト含む) と、請求書払いの返金を同じ台帳で扱う。
--    返金は売上のマイナスなので、代理店フィーの支払対象からも除外できるようにする。
--
-- 2) 解約者台帳
--    「どの顧客が、いつ、どれだけ契約していたか」を解約時点でスナップショットして残す。
--    テナント本体は解約6ヶ月後にデータ削除されるため、そのままでは
--    解約者リストが消えてしまう。将来の再アプローチ用に顧客情報を保持する。
-- =========================================================

-- =========================================================
-- 1. 返金台帳
-- =========================================================
CREATE TABLE IF NOT EXISTS refunds (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source            TEXT NOT NULL DEFAULT 'stripe',   -- stripe | invoice | manual
    organization_id   UUID REFERENCES organizations(id) ON DELETE SET NULL,
    contract_id       TEXT NOT NULL DEFAULT '',
    shop_name         TEXT NOT NULL DEFAULT '',
    company_name      TEXT NOT NULL DEFAULT '',
    invoice_no        TEXT,                              -- 請求書払いの返金なら対象請求書
    amount            NUMERIC(12,2) NOT NULL DEFAULT 0,  -- 返金額(税込・正の数)
    currency          TEXT NOT NULL DEFAULT 'jpy',
    reason            TEXT NOT NULL DEFAULT '',
    refunded_at       DATE NOT NULL DEFAULT CURRENT_DATE,
    is_test           BOOLEAN NOT NULL DEFAULT false,    -- Stripeテストモードの返金
    stripe_refund_id  TEXT UNIQUE,
    stripe_charge_id  TEXT,
    stripe_invoice_id TEXT,
    note              TEXT NOT NULL DEFAULT '',
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_refunds_contract   ON refunds(contract_id);
CREATE INDEX IF NOT EXISTS idx_refunds_refunded   ON refunds(refunded_at DESC);
CREATE INDEX IF NOT EXISTS idx_refunds_invoice_no ON refunds(invoice_no) WHERE invoice_no IS NOT NULL;

ALTER TABLE refunds ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "refunds_no_direct" ON refunds;
CREATE POLICY "refunds_no_direct" ON refunds FOR ALL TO anon USING (false) WITH CHECK (false);

-- 請求書側にも返金額を持たせ、残額計算を狂わせない
ALTER TABLE invoices
    ADD COLUMN IF NOT EXISTS refunded_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS refunded_at DATE;


-- =========================================================
-- 2. 返金の記録
--    Stripe Webhook からも、運営の手動操作からも同じ関数を通す。
--    同じ stripe_refund_id は二重計上しない。
-- =========================================================
CREATE OR REPLACE FUNCTION record_refund(
    p_source           TEXT,
    p_contract_id      TEXT,
    p_amount           NUMERIC,
    p_refunded_at      DATE DEFAULT NULL,
    p_reason           TEXT DEFAULT '',
    p_invoice_no       TEXT DEFAULT NULL,
    p_stripe_refund_id TEXT DEFAULT NULL,
    p_stripe_charge_id TEXT DEFAULT NULL,
    p_stripe_invoice_id TEXT DEFAULT NULL,
    p_is_test          BOOLEAN DEFAULT false,
    p_currency         TEXT DEFAULT 'jpy'
) RETURNS JSONB AS $$
DECLARE
    v_org  UUID;
    v_shop TEXT := '';
    v_comp TEXT := '';
    v_id   UUID;
BEGIN
    IF COALESCE(p_amount, 0) <= 0 THEN
        RETURN jsonb_build_object('success', false, 'message', '返金額が不正です');
    END IF;

    -- 二重計上の防止 (Webhook は再送されることがある)
    IF p_stripe_refund_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM refunds WHERE stripe_refund_id = p_stripe_refund_id
    ) THEN
        RETURN jsonb_build_object('success', true, 'duplicated', true,
                                  'stripe_refund_id', p_stripe_refund_id);
    END IF;

    SELECT c.organization_id, o.name, COALESCE(c.company_name, '')
      INTO v_org, v_shop, v_comp
      FROM config c JOIN organizations o ON o.id = c.organization_id
     WHERE c.contract_id = p_contract_id
     LIMIT 1;

    INSERT INTO refunds (source, organization_id, contract_id, shop_name, company_name,
                         invoice_no, amount, currency, reason, refunded_at, is_test,
                         stripe_refund_id, stripe_charge_id, stripe_invoice_id)
    VALUES (COALESCE(NULLIF(p_source, ''), 'stripe'), v_org, COALESCE(p_contract_id, ''),
            COALESCE(v_shop, ''), COALESCE(v_comp, ''),
            NULLIF(p_invoice_no, ''), p_amount, COALESCE(p_currency, 'jpy'),
            COALESCE(p_reason, ''), COALESCE(p_refunded_at, CURRENT_DATE),
            COALESCE(p_is_test, false),
            NULLIF(p_stripe_refund_id, ''), NULLIF(p_stripe_charge_id, ''),
            NULLIF(p_stripe_invoice_id, ''))
    RETURNING id INTO v_id;

    -- 請求書払いの返金は、その請求書にも反映する
    IF p_invoice_no IS NOT NULL AND p_invoice_no <> '' THEN
        UPDATE invoices
           SET refunded_amount = refunded_amount + p_amount,
               refunded_at     = COALESCE(p_refunded_at, CURRENT_DATE),
               note            = CASE WHEN COALESCE(p_reason, '') = '' THEN note
                                      ELSE trim(both E'\n' from note || E'\n返金: ' || p_reason) END
         WHERE invoice_no = p_invoice_no;
    END IF;

    RETURN jsonb_build_object('success', true, 'id', v_id, 'amount', p_amount);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp;


CREATE OR REPLACE FUNCTION list_refunds(p_from DATE DEFAULT NULL)
RETURNS JSONB AS $$
    SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.refunded_at DESC, r.created_at DESC), '[]'::jsonb)
    FROM refunds r
    WHERE p_from IS NULL OR r.refunded_at >= p_from;
$$ LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp;


-- =========================================================
-- 3. 解約者台帳
--    解約時点の顧客情報を丸ごと保存する。テナント削除後も残る。
-- =========================================================
CREATE TABLE IF NOT EXISTS cancellations (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id   UUID,                              -- 参照のみ (FKを張らない=テナント削除後も残す)
    contract_id       TEXT NOT NULL DEFAULT '',
    shop_name         TEXT NOT NULL DEFAULT '',
    company_name      TEXT NOT NULL DEFAULT '',
    contact_name      TEXT NOT NULL DEFAULT '',
    email             TEXT NOT NULL DEFAULT '',
    phone             TEXT NOT NULL DEFAULT '',
    address           TEXT NOT NULL DEFAULT '',

    plan              TEXT NOT NULL DEFAULT '',
    billing_category  TEXT NOT NULL DEFAULT '',
    monthly_amount    NUMERIC(12,2) NOT NULL DEFAULT 0,
    referrer_code     TEXT NOT NULL DEFAULT '',

    started_on        DATE,                              -- 契約開始日
    cancel_requested_at TIMESTAMPTZ,                     -- 解約申請日時
    cancelled_on      DATE,                              -- 解約発効日
    contract_days     INTEGER NOT NULL DEFAULT 0,        -- 契約日数
    contract_months   NUMERIC(6,1) NOT NULL DEFAULT 0,   -- 契約月数 (小数第1位)
    is_early_churn    BOOLEAN NOT NULL DEFAULT false,    -- 早期解約か

    total_billed      NUMERIC(12,2) NOT NULL DEFAULT 0,
    total_paid        NUMERIC(12,2) NOT NULL DEFAULT 0,
    total_refunded    NUMERIC(12,2) NOT NULL DEFAULT 0,

    reason            TEXT NOT NULL DEFAULT '',
    note              TEXT NOT NULL DEFAULT '',
    recorded_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_cancellations_contract_date
    ON cancellations(contract_id, cancelled_on);
CREATE INDEX IF NOT EXISTS idx_cancellations_cancelled ON cancellations(cancelled_on DESC);
CREATE INDEX IF NOT EXISTS idx_cancellations_early ON cancellations(is_early_churn) WHERE is_early_churn;

ALTER TABLE cancellations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "cancellations_no_direct" ON cancellations;
CREATE POLICY "cancellations_no_direct" ON cancellations FOR ALL TO anon USING (false) WITH CHECK (false);

-- 早期解約の判定月数 (既定6ヶ月未満)
INSERT INTO platform_settings (key, value, description) VALUES
    ('early_churn_months', '6', '契約期間がこの月数未満の解約を「早期解約」として集計する')
ON CONFLICT (key) DO NOTHING;


-- =========================================================
-- 4. 解約のスナップショット記録
--    解約発効時に呼ぶ。同じ顧客・同じ解約日なら上書き更新する。
-- =========================================================
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
    ON CONFLICT (contract_id, cancelled_on) DO UPDATE SET
        contract_days = EXCLUDED.contract_days,
        contract_months = EXCLUDED.contract_months,
        is_early_churn = EXCLUDED.is_early_churn,
        total_billed = EXCLUDED.total_billed,
        total_paid = EXCLUDED.total_paid,
        total_refunded = EXCLUDED.total_refunded,
        reason = CASE WHEN EXCLUDED.reason = '' THEN cancellations.reason ELSE EXCLUDED.reason END,
        recorded_at = now();

    RETURN jsonb_build_object('success', true, 'contract_id', p_contract_id,
                              'contract_days', v_days, 'contract_months', v_months,
                              'is_early_churn', (v_months < v_early_m));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp;


-- =========================================================
-- 5. 解約中/解約済みの顧客をまとめて台帳へ取り込む
--    (既存の解約済みテナントを初回に拾う。以後は日次で差分だけ入る)
-- =========================================================
CREATE OR REPLACE FUNCTION sync_cancellations()
RETURNS JSONB AS $$
DECLARE
    rec RECORD;
    n INTEGER := 0;
BEGIN
    FOR rec IN
        SELECT contract_id,
               COALESCE(cancel_effective_date,
                        (cancel_requested_at AT TIME ZONE 'Asia/Tokyo')::DATE,
                        (now() AT TIME ZONE 'Asia/Tokyo')::DATE) AS eff
          FROM v_customer_ledger
         WHERE license_status = 'suspended'
            OR subscription_status = 'canceled'
            OR cancel_requested_at IS NOT NULL
    LOOP
        PERFORM record_cancellation(rec.contract_id, rec.eff, '');
        n := n + 1;
    END LOOP;
    RETURN jsonb_build_object('success', true, 'synced', n);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp;


CREATE OR REPLACE FUNCTION list_cancellations()
RETURNS JSONB AS $$
    SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.cancelled_on DESC), '[]'::jsonb)
    FROM cancellations x;
$$ LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp;


-- =========================================================
-- 6. 権限
-- =========================================================
REVOKE EXECUTE ON FUNCTION record_refund(TEXT, TEXT, NUMERIC, DATE, TEXT, TEXT, TEXT, TEXT, TEXT, BOOLEAN, TEXT)
                                                        FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION list_refunds(DATE)           FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION record_cancellation(TEXT, DATE, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION sync_cancellations()         FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION list_cancellations()         FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, UPDATE ON TABLE refunds TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE cancellations TO service_role;
GRANT EXECUTE ON FUNCTION record_refund(TEXT, TEXT, NUMERIC, DATE, TEXT, TEXT, TEXT, TEXT, TEXT, BOOLEAN, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION list_refunds(DATE) TO service_role;
GRANT EXECUTE ON FUNCTION record_cancellation(TEXT, DATE, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION sync_cancellations() TO service_role;
GRANT EXECUTE ON FUNCTION list_cancellations() TO service_role;

NOTIFY pgrst, 'reload schema';
