-- =========================================================
-- 88_anniversary_billing.sql   (v3.7.286)
--
-- 請求方式を「暦月一括」から「契約日基準の月次」へ変更する。
--   例) 8/15 契約 → 8/15〜9/14, 9/15〜10/14, … を1ヶ月単位で請求
--
-- あわせて運用ルールを実装:
--   - 支払期限 = 発行日 + 10日
--   - 請求書番号はランダム (連番だと発行件数が外部から推測できるため)
--   - 過去分の遡り請求はしない (現在の請求期間のみを生成)
-- =========================================================

-- =========================================================
-- 1. 請求サイクルの基準日
--    既定は契約日(組織の作成日)。運用開始日をずらしたい顧客は個別に変更する。
-- =========================================================
ALTER TABLE config
    ADD COLUMN IF NOT EXISTS billing_start_date DATE;

UPDATE config c
   SET billing_start_date = o.created_at::DATE
  FROM organizations o
 WHERE o.id = c.organization_id
   AND c.billing_start_date IS NULL;

-- 支払期限は発行日+10日を既定に
ALTER TABLE config ALTER COLUMN payment_terms_days SET DEFAULT 10;
UPDATE config SET payment_terms_days = 10 WHERE COALESCE(payment_terms_days, 30) = 30;


-- =========================================================
-- 2. 請求対象期間
--    billing_month は「その請求がどの月のものか」の目安として残し、
--    実際の対象期間は period_start / period_end で持つ。
-- =========================================================
ALTER TABLE invoices
    ADD COLUMN IF NOT EXISTS period_start DATE,
    ADD COLUMN IF NOT EXISTS period_end   DATE;

UPDATE invoices
   SET period_start = billing_month,
       period_end   = (billing_month + INTERVAL '1 month' - INTERVAL '1 day')::DATE
 WHERE period_start IS NULL;

-- 同一顧客・同一期間の二重請求を防ぐ (暦月ベースの旧制約を置き換え)
DROP INDEX IF EXISTS uq_invoices_org_month;
CREATE UNIQUE INDEX IF NOT EXISTS uq_invoices_org_period
    ON invoices(organization_id, period_start)
    WHERE status <> 'void' AND organization_id IS NOT NULL;


-- =========================================================
-- 3. 請求書番号 (ランダム)
--    連番は「発行件数」「顧客数」が外部に推測できてしまうため避ける。
--    重複したら引き直す。
-- =========================================================
CREATE OR REPLACE FUNCTION gen_invoice_no()
RETURNS TEXT AS $$
DECLARE
    v_no TEXT;
    i INT := 0;
BEGIN
    LOOP
        -- INV- + 10桁の数字 (先頭0を許容しないよう1〜9で開始)
        v_no := 'INV-' || (floor(random() * 9 + 1))::INT::TEXT
                       || lpad(floor(random() * 1000000000)::BIGINT::TEXT, 9, '0');
        EXIT WHEN NOT EXISTS (SELECT 1 FROM invoices WHERE invoice_no = v_no);
        i := i + 1;
        IF i > 50 THEN
            RAISE EXCEPTION '請求書番号の生成に失敗しました';
        END IF;
    END LOOP;
    RETURN v_no;
END;
$$ LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp;


-- =========================================================
-- 4. 支払期限の既定を 10日 に変更
-- =========================================================
CREATE OR REPLACE FUNCTION invoices_recalc()
RETURNS TRIGGER AS $$
DECLARE
    v_gross NUMERIC(12,2);
BEGIN
    NEW.billing_month := date_trunc('month', NEW.billing_month)::DATE;
    NEW.qty := GREATEST(COALESCE(NEW.qty, 1), 0);
    v_gross := ROUND(COALESCE(NEW.unit_price, 0) * NEW.qty);

    -- 単価は税込で入る運用。tax_included=false のときだけ外税として扱う。
    IF COALESCE(NEW.tax_included, true) THEN
        NEW.total    := v_gross;
        NEW.tax      := ROUND(v_gross * NEW.tax_rate / (100 + NEW.tax_rate));
        NEW.subtotal := NEW.total - NEW.tax;
    ELSE
        NEW.subtotal := v_gross;
        NEW.tax      := ROUND(v_gross * NEW.tax_rate / 100);
        NEW.total    := NEW.subtotal + NEW.tax;
    END IF;

    -- 対象期間が未設定なら請求月から補完
    IF NEW.period_start IS NULL THEN
        NEW.period_start := NEW.billing_month;
    END IF;
    IF NEW.period_end IS NULL THEN
        NEW.period_end := (NEW.period_start + INTERVAL '1 month' - INTERVAL '1 day')::DATE;
    END IF;

    IF NEW.due_date IS NULL THEN
        NEW.due_date := NEW.issue_date + 10;   -- 発行日 + 10日
    END IF;

    IF NEW.status NOT IN ('void', 'draft') THEN
        IF NEW.paid_amount >= NEW.total AND NEW.total > 0 THEN
            NEW.status := 'paid';
            NEW.paid_at := COALESCE(NEW.paid_at, CURRENT_DATE);
        ELSIF NEW.paid_amount > 0 THEN
            NEW.status := 'partial';
        ELSIF NEW.status = 'paid' OR NEW.status = 'partial' THEN
            NEW.status := CASE WHEN NEW.sent_at IS NOT NULL THEN 'sent' ELSE 'issued' END;
            NEW.paid_at := NULL;
        END IF;
    END IF;

    NEW.updated_at := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp;


-- =========================================================
-- 5. 顧客台帳ビューに請求サイクル情報を追加
--    列構成が変わるため、CREATE OR REPLACE ではなく作り直す。
-- =========================================================
DROP VIEW IF EXISTS v_customer_ledger CASCADE;
CREATE VIEW v_customer_ledger AS
SELECT
    o.id                                    AS organization_id,
    c.contract_id,
    o.name                                  AS shop_name,
    COALESCE(c.company_name, '')            AS company_name,
    COALESCE(c.contact_name, '')            AS contact_name,
    -- 請求先メールの優先順: 請求先 → 申込時 → 担当者。
    -- それぞれ NULLIF で空文字を NULL にしてから COALESCE すること。
    -- 素の COALESCE だと customer_email='' でそこで確定し、担当者メールまで降りない。
    COALESCE(NULLIF(trim(c.billing_email), ''),
             NULLIF(trim(c.customer_email), ''),
             NULLIF(trim(c.contact_email), ''),
             '')                                AS billing_email,
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


-- =========================================================
-- 6. 契約日基準の請求書生成
--
--    「今日が属する請求期間」だけを作る。過去に遡って何ヶ月分も作ることはしない
--    (運用開始時に大量の過去請求が飛ぶ事故を防ぐため)。
--    毎日実行することで、各顧客の応当日に1件ずつ生成される。
-- =========================================================
CREATE OR REPLACE FUNCTION generate_due_invoices(
    p_asof DATE DEFAULT NULL,
    p_contract_id TEXT DEFAULT NULL      -- 指定時はその顧客だけを対象にする
)
RETURNS JSONB AS $$
DECLARE
    v_asof    DATE := COALESCE(p_asof, (now() AT TIME ZONE 'Asia/Tokyo')::DATE);
    v_created INTEGER := 0;
    v_skipped INTEGER := 0;
    v_no_price TEXT[] := '{}';
    v_list    JSONB := '[]'::jsonb;
    rec       RECORD;
    v_n       INTEGER;
    v_start   DATE;
    v_end     DATE;
    v_no      TEXT;
BEGIN
    FOR rec IN
        SELECT * FROM v_customer_ledger
        WHERE billing_category IN ('invoice', 'oem')
          AND license_status = 'active'
          AND COALESCE(subscription_status, '') <> 'canceled'
          AND (cancel_effective_date IS NULL OR cancel_effective_date >= v_asof)
          AND (p_contract_id IS NULL OR contract_id = p_contract_id)
        ORDER BY contract_id
    LOOP
        -- 基準日より前は請求しない
        IF rec.billing_start_date IS NULL OR rec.billing_start_date > v_asof THEN
            CONTINUE;
        END IF;

        -- 今日が属する請求期間を求める。
        --
        -- age() の月数だけで決めてはいけない。月末契約でずれるため。
        --   例) 5/31 契約・6/30 時点
        --       age(6/30, 5/31) = 30日 = 0ヶ月 → 期間 5/31〜6/29 (6/30 を含まない)
        --       一方 '5/31'::date + 1 month = 6/30 なので、正しい期間は 6/30〜7/30
        --   この不一致を放置すると 6/30〜7/30 が丸ごと生成されず、1ヶ月分の請求漏れになる。
        -- age() は当たりを付けるだけに使い、
        --   start(n) <= 基準日 < start(n+1) を満たすまで前後に補正する。
        v_n := (EXTRACT(YEAR FROM age(v_asof, rec.billing_start_date)) * 12
                + EXTRACT(MONTH FROM age(v_asof, rec.billing_start_date)))::INTEGER;
        v_n := GREATEST(v_n, 0);

        WHILE (rec.billing_start_date + ((v_n + 1) || ' months')::INTERVAL)::DATE <= v_asof LOOP
            v_n := v_n + 1;
        END LOOP;
        WHILE v_n > 0
          AND (rec.billing_start_date + (v_n || ' months')::INTERVAL)::DATE > v_asof LOOP
            v_n := v_n - 1;
        END LOOP;

        v_start := (rec.billing_start_date + (v_n || ' months')::INTERVAL)::DATE;
        v_end   := (rec.billing_start_date + ((v_n + 1) || ' months')::INTERVAL - INTERVAL '1 day')::DATE;

        IF EXISTS (SELECT 1 FROM invoices
                    WHERE organization_id = rec.organization_id
                      AND period_start = v_start
                      AND status <> 'void') THEN
            v_skipped := v_skipped + 1;
            CONTINUE;
        END IF;

        IF COALESCE(rec.monthly_amount, 0) <= 0 THEN
            v_no_price := v_no_price || rec.contract_id;
            CONTINUE;
        END IF;

        v_no := gen_invoice_no();
        INSERT INTO invoices (
            invoice_no, organization_id, contract_id, shop_name, company_name,
            billing_email, billing_category, billing_month, period_start, period_end,
            issue_date, due_date, plan, qty, unit_price, referrer_code, agency_fee
        ) VALUES (
            v_no, rec.organization_id, rec.contract_id, rec.shop_name, rec.company_name,
            rec.billing_email, rec.billing_category,
            date_trunc('month', v_start)::DATE, v_start, v_end,
            v_asof, v_asof + COALESCE(rec.payment_terms_days, 10),
            rec.plan, 1, rec.monthly_amount, rec.referrer_code, rec.agency_fee_monthly
        );
        v_created := v_created + 1;
        v_list := v_list || jsonb_build_object(
            'invoice_no', v_no, 'contract_id', rec.contract_id,
            'shop_name', rec.shop_name, 'company_name', rec.company_name,
            'billing_email', rec.billing_email,
            'period_start', v_start, 'period_end', v_end,
            'due_date', v_asof + COALESCE(rec.payment_terms_days, 10),
            'total', rec.monthly_amount);
    END LOOP;

    RETURN jsonb_build_object(
        'success', true,
        'asof', to_char(v_asof, 'YYYY-MM-DD'),
        'created', v_created,
        'skipped', v_skipped,
        'no_price_count', COALESCE(array_length(v_no_price, 1), 0),
        'no_price_contracts', to_jsonb(v_no_price),
        'invoices', v_list
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp;


-- =========================================================
-- 7. 旧「暦月一括生成」は契約日基準の入口へ寄せる
--    (管理コンソールの既存ボタンから呼ばれても破綻しないようにする)
-- =========================================================
CREATE OR REPLACE FUNCTION generate_monthly_invoices(p_month DATE DEFAULT NULL)
RETURNS JSONB AS $$
    SELECT generate_due_invoices(
        CASE WHEN p_month IS NULL THEN NULL
             -- 指定月が当月なら今日、過去月ならその月末を基準に判定する
             ELSE LEAST((now() AT TIME ZONE 'Asia/Tokyo')::DATE,
                        (date_trunc('month', p_month) + INTERVAL '1 month' - INTERVAL '1 day')::DATE)
        END, NULL);
$$ LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp;


-- =========================================================
-- 8. 顧客の請求サイクル基準日を更新できるようにする
-- =========================================================
CREATE OR REPLACE FUNCTION update_customer_agency(
    p_contract_id  TEXT,
    p_referrer_code TEXT DEFAULT NULL,
    p_fee_type     TEXT DEFAULT NULL,
    p_fee_amount   NUMERIC DEFAULT NULL,
    p_billing_email TEXT DEFAULT NULL,
    p_payment_terms_days INTEGER DEFAULT NULL,
    p_billing_start_date DATE DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
    v_code TEXT := CASE WHEN p_referrer_code IS NULL THEN NULL
                        ELSE upper(trim(p_referrer_code)) END;
BEGIN
    IF p_fee_type IS NOT NULL
       AND lower(p_fee_type) NOT IN ('inherit', 'fixed', 'percent', 'none') THEN
        RETURN jsonb_build_object('success', false, 'contract_id', p_contract_id,
                                  'message', 'fee_type が不正です');
    END IF;

    IF v_code IS NOT NULL AND v_code <> '' AND NOT EXISTS (
        SELECT 1 FROM referrers WHERE upper(trim(code)) = v_code
    ) THEN
        RETURN jsonb_build_object('success', false, 'contract_id', p_contract_id,
                                  'message', '紹介者コードが未登録です: ' || v_code);
    END IF;

    UPDATE config
       SET referrer_code       = COALESCE(v_code, referrer_code),
           agency_fee_type     = COALESCE(lower(p_fee_type), agency_fee_type),
           agency_fee_amount   = COALESCE(p_fee_amount, agency_fee_amount),
           billing_email       = COALESCE(p_billing_email, billing_email),
           payment_terms_days  = COALESCE(p_payment_terms_days, payment_terms_days),
           billing_start_date  = COALESCE(p_billing_start_date, billing_start_date)
     WHERE contract_id = p_contract_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'contract_id', p_contract_id,
                                  'message', '契約IDが見つかりません');
    END IF;
    RETURN jsonb_build_object('success', true, 'contract_id', p_contract_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp;

DROP FUNCTION IF EXISTS update_customer_agency(TEXT, TEXT, TEXT, NUMERIC, TEXT, INTEGER);


-- =========================================================
-- 9. 送信済みの記録 (自動送信を有効にしたときに使う)
-- =========================================================
CREATE OR REPLACE FUNCTION mark_invoices_sent(p_invoice_nos TEXT[])
RETURNS JSONB AS $$
DECLARE v_n INTEGER;
BEGIN
    UPDATE invoices
       SET sent_at = now(),
           status  = CASE WHEN status = 'issued' THEN 'sent' ELSE status END
     WHERE invoice_no = ANY(p_invoice_nos)
       AND status NOT IN ('void', 'paid');
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RETURN jsonb_build_object('success', true, 'updated', v_n);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp;


-- =========================================================
-- 10. 権限 (PUBLIC から剥奪し service_role にのみ付与)
-- =========================================================
-- 旧い1引数版が残っていると呼び出しが曖昧になるため、あれば落としてから権限を張る
DROP FUNCTION IF EXISTS generate_due_invoices(DATE);
REVOKE EXECUTE ON FUNCTION generate_due_invoices(DATE, TEXT)  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION generate_monthly_invoices(DATE)    FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION gen_invoice_no()                   FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION mark_invoices_sent(TEXT[])         FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION update_customer_agency(TEXT, TEXT, TEXT, NUMERIC, TEXT, INTEGER, DATE)
                                                              FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE v_customer_ledger                         FROM anon, authenticated;

GRANT SELECT ON TABLE v_customer_ledger TO service_role;
GRANT EXECUTE ON FUNCTION generate_due_invoices(DATE, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION generate_monthly_invoices(DATE) TO service_role;
GRANT EXECUTE ON FUNCTION gen_invoice_no() TO service_role;
GRANT EXECUTE ON FUNCTION mark_invoices_sent(TEXT[]) TO service_role;
GRANT EXECUTE ON FUNCTION update_customer_agency(TEXT, TEXT, TEXT, NUMERIC, TEXT, INTEGER, DATE) TO service_role;

NOTIFY pgrst, 'reload schema';
