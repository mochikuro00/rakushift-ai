-- =========================================================
-- 87_billing_ledger_and_agency.sql   (v3.7.285)
--
-- 目的:
--   1) 「運営管理者の請求書ベースの入金履歴が紐づかない」の根本修正。
--      決済管理タブは Stripe API を直読みしていただけで、請求書払い / OEM の
--      顧客には請求レコードも入金レコードも保存先が存在しなかった。
--      → invoices テーブル (請求書 + 入金台帳) を新設し、顧客(config)に紐付ける。
--   2) 代理店(紹介者)フィーを顧客単位で上書き設定できるようにする。
--      referrers 側の率/固定額を既定値として継承し、個別交渉分だけ顧客で上書き。
--   3) お問い合わせ(inquiries) と 顧客(config) の突合を SQL 側で持ち、
--      GAS スプレッドシートから「抜け」を一発で検出できるようにする。
-- =========================================================

-- =========================================================
-- 1. プラン単価の単一情報源
--    (これまで list_referrers / admin.html / main.py に価格がベタ書きで散在し、
--     改定のたびに不整合が起きていた)
-- =========================================================
CREATE OR REPLACE FUNCTION get_plan_price(p_plan TEXT)
RETURNS NUMERIC AS $$
    SELECT CASE lower(COALESCE(p_plan, ''))
        WHEN 'standard' THEN 3380
        WHEN 'pro'      THEN 4880
        WHEN 'premium'  THEN 9980
        WHEN 'oem'      THEN 4000
        ELSE 0
    END::NUMERIC;
$$ LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, public, pg_temp;


-- =========================================================
-- 2. config: 代理店(紹介者)フィーの顧客単位設定
--    agency_fee_type:
--      'inherit' = referrers の設定を継承 (既定)
--      'fixed'   = agency_fee_amount を毎月そのまま計上
--      'percent' = 月額の agency_fee_amount % を計上
--      'none'    = この顧客はフィー対象外
-- =========================================================
-- contact_email は config には存在しなかった (同名列があるのは hq_admins のみ)。
-- それにもかかわらず main.py の /admin/customers が config から contact_email を
-- select しており、PostgREST が 400 を返して顧客一覧が空になりうる状態だった。
-- ここで列を追加して整合させる (既にある環境では IF NOT EXISTS で無害)。
ALTER TABLE config
    ADD COLUMN IF NOT EXISTS contact_email     TEXT    DEFAULT '',
    ADD COLUMN IF NOT EXISTS agency_fee_type   TEXT    DEFAULT 'inherit',
    ADD COLUMN IF NOT EXISTS agency_fee_amount NUMERIC(12,2) DEFAULT 0,
    ADD COLUMN IF NOT EXISTS billing_email     TEXT    DEFAULT '',
    ADD COLUMN IF NOT EXISTS payment_terms_days INTEGER DEFAULT 30,
    ADD COLUMN IF NOT EXISTS billing_note      TEXT    DEFAULT '';

DO $$ BEGIN
    ALTER TABLE config ADD CONSTRAINT config_agency_fee_type_chk
        CHECK (agency_fee_type IN ('inherit', 'fixed', 'percent', 'none'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_config_referrer_code ON config(upper(trim(referrer_code)));


-- =========================================================
-- 3. invoices: 請求書 + 入金台帳
--    Stripe 契約も手動契約も同じ台帳に載せることで、運営は1画面/1シートで
--    「誰にいくら請求して、いつ入金されたか」を追える。
-- =========================================================
CREATE TABLE IF NOT EXISTS invoices (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_no        TEXT UNIQUE NOT NULL,              -- INV-202608-0001
    organization_id   UUID REFERENCES organizations(id) ON DELETE SET NULL,
    contract_id       TEXT NOT NULL DEFAULT '',          -- 組織削除後も履歴を追えるよう冗長保持
    shop_name         TEXT NOT NULL DEFAULT '',
    company_name      TEXT NOT NULL DEFAULT '',
    billing_email     TEXT NOT NULL DEFAULT '',

    billing_category  TEXT NOT NULL DEFAULT 'invoice',   -- invoice | oem | stripe
    billing_month     DATE NOT NULL,                     -- 対象月 (月初日に正規化)
    issue_date        DATE NOT NULL DEFAULT CURRENT_DATE,
    due_date          DATE,

    plan              TEXT NOT NULL DEFAULT '',
    qty               INTEGER NOT NULL DEFAULT 1,
    unit_price        NUMERIC(12,2) NOT NULL DEFAULT 0,  -- 税込単価
    tax_rate          NUMERIC(5,2)  NOT NULL DEFAULT 10,
    tax_included      BOOLEAN       NOT NULL DEFAULT true,
    subtotal          NUMERIC(12,2) NOT NULL DEFAULT 0,  -- 税抜
    tax               NUMERIC(12,2) NOT NULL DEFAULT 0,
    total             NUMERIC(12,2) NOT NULL DEFAULT 0,  -- 請求総額(税込)

    status            TEXT NOT NULL DEFAULT 'issued',    -- draft|issued|sent|paid|partial|void
    paid_at           DATE,
    paid_amount       NUMERIC(12,2) NOT NULL DEFAULT 0,
    payment_method    TEXT NOT NULL DEFAULT '',          -- bank | stripe | cash | offset
    payer_name        TEXT NOT NULL DEFAULT '',          -- 振込名義 (消込の突合キー)

    stripe_invoice_id  TEXT,
    stripe_invoice_url TEXT,

    referrer_code     TEXT NOT NULL DEFAULT '',
    agency_fee        NUMERIC(12,2) NOT NULL DEFAULT 0,  -- この請求に対して確定した代理店フィー
    agency_fee_paid_at DATE,

    email_draft_at    TIMESTAMPTZ,                       -- Gmail下書きを作成した日時
    sent_at           TIMESTAMPTZ,
    note              TEXT NOT NULL DEFAULT '',
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$ BEGIN
    ALTER TABLE invoices ADD CONSTRAINT invoices_status_chk
        CHECK (status IN ('draft', 'issued', 'sent', 'paid', 'partial', 'void'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 同一顧客・同一対象月の二重請求を防ぐ (void は除外して再発行を許す)
CREATE UNIQUE INDEX IF NOT EXISTS uq_invoices_org_month
    ON invoices(organization_id, billing_month)
    WHERE status <> 'void' AND organization_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_invoices_contract     ON invoices(contract_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status       ON invoices(status);
CREATE INDEX IF NOT EXISTS idx_invoices_month        ON invoices(billing_month DESC);
CREATE INDEX IF NOT EXISTS idx_invoices_referrer     ON invoices(upper(trim(referrer_code)));
CREATE INDEX IF NOT EXISTS idx_invoices_stripe_inv   ON invoices(stripe_invoice_id)
    WHERE stripe_invoice_id IS NOT NULL;

-- RLS: 直接アクセスは全面禁止。運営APIは service_role で、GASは Railway API 経由。
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "invoices_no_direct" ON invoices;
CREATE POLICY "invoices_no_direct" ON invoices
    FOR ALL TO anon USING (false) WITH CHECK (false);


-- =========================================================
-- 4. 金額の自動計算トリガ
--    GAS / 管理画面 / 月次生成 のどこから入っても金額整合が崩れないよう、
--    subtotal / tax / total と status は DB 側で確定させる。
-- =========================================================
CREATE OR REPLACE FUNCTION invoices_recalc()
RETURNS TRIGGER AS $$
DECLARE
    v_gross NUMERIC(12,2);
BEGIN
    NEW.billing_month := date_trunc('month', NEW.billing_month)::DATE;
    NEW.qty := GREATEST(COALESCE(NEW.qty, 1), 0);
    v_gross := ROUND(COALESCE(NEW.unit_price, 0) * NEW.qty);

    IF COALESCE(NEW.tax_included, true) THEN
        NEW.total    := v_gross;
        NEW.tax      := ROUND(v_gross * NEW.tax_rate / (100 + NEW.tax_rate));
        NEW.subtotal := NEW.total - NEW.tax;
    ELSE
        NEW.subtotal := v_gross;
        NEW.tax      := ROUND(v_gross * NEW.tax_rate / 100);
        NEW.total    := NEW.subtotal + NEW.tax;
    END IF;

    IF NEW.due_date IS NULL THEN
        NEW.due_date := NEW.issue_date + 30;
    END IF;

    -- 入金額から状態を確定 (void / draft は手動状態なので尊重する)
    IF NEW.status NOT IN ('void', 'draft') THEN
        IF NEW.paid_amount >= NEW.total AND NEW.total > 0 THEN
            NEW.status := 'paid';
            NEW.paid_at := COALESCE(NEW.paid_at, CURRENT_DATE);
        ELSIF NEW.paid_amount > 0 THEN
            NEW.status := 'partial';
        ELSIF NEW.status = 'paid' OR NEW.status = 'partial' THEN
            -- 入金取消時は発行済みへ戻す
            NEW.status := CASE WHEN NEW.sent_at IS NOT NULL THEN 'sent' ELSE 'issued' END;
            NEW.paid_at := NULL;
        END IF;
    END IF;

    NEW.updated_at := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp;

DROP TRIGGER IF EXISTS trg_invoices_recalc ON invoices;
CREATE TRIGGER trg_invoices_recalc
    BEFORE INSERT OR UPDATE ON invoices
    FOR EACH ROW EXECUTE FUNCTION invoices_recalc();


-- =========================================================
-- 5. 代理店(紹介者)フィーの解決
--    顧客側の設定を優先し、'inherit' のときだけ referrers の条件を使う。
-- =========================================================
CREATE OR REPLACE FUNCTION resolve_agency_fee(
    p_referrer_code TEXT,
    p_plan          TEXT,
    p_fee_type      TEXT,
    p_fee_amount    NUMERIC,
    p_monthly       NUMERIC
) RETURNS NUMERIC AS $$
DECLARE
    r        RECORD;
    v_type   TEXT := lower(COALESCE(p_fee_type, 'inherit'));
    v_base   NUMERIC := COALESCE(p_monthly, 0);
BEGIN
    IF p_referrer_code IS NULL OR trim(p_referrer_code) = '' THEN
        RETURN 0;
    END IF;

    IF v_type = 'none' THEN
        RETURN 0;
    ELSIF v_type = 'fixed' THEN
        RETURN ROUND(COALESCE(p_fee_amount, 0));
    ELSIF v_type = 'percent' THEN
        RETURN ROUND(v_base * COALESCE(p_fee_amount, 0) / 100);
    END IF;

    -- inherit: 紹介者マスタの条件
    SELECT commission_type, commission_rate, commission_amount, active
      INTO r
      FROM referrers
     WHERE upper(trim(code)) = upper(trim(p_referrer_code))
     LIMIT 1;

    IF NOT FOUND OR COALESCE(r.active, true) = false THEN
        RETURN 0;
    END IF;

    IF COALESCE(r.commission_type, 'percent') = 'fixed' THEN
        RETURN ROUND(COALESCE(r.commission_amount, 0));
    END IF;
    RETURN ROUND(v_base * COALESCE(r.commission_rate, 0) / 100);
END;
$$ LANGUAGE plpgsql STABLE
SET search_path = pg_catalog, public, pg_temp;


-- =========================================================
-- 6. 顧客台帳ビュー (顧客管理シートの元データ)
--    請求カテゴリー・プラン・代理店・代理店フィー・入金状況を1行に集約。
-- =========================================================
-- 後続マイグレーションで列構成が変わるため、置換ではなく作り直す
-- (CREATE OR REPLACE VIEW は列の削除ができず、再適用時に失敗する)
DROP VIEW IF EXISTS v_customer_ledger CASCADE;
CREATE VIEW v_customer_ledger AS
SELECT
    o.id                                    AS organization_id,
    c.contract_id,
    o.name                                  AS shop_name,
    COALESCE(c.company_name, '')            AS company_name,
    COALESCE(c.contact_name, '')            AS contact_name,
    COALESCE(NULLIF(c.billing_email, ''),
             c.customer_email, c.contact_email, '') AS billing_email,
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
    COALESCE(c.payment_terms_days, 30)      AS payment_terms_days,
    COALESCE(c.billing_note, '')            AS billing_note,
    o.created_at,
    inv.last_invoice_month,
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
        count(*) FILTER (WHERE i.status IN ('issued', 'sent', 'partial'))       AS unpaid_count,
        COALESCE(sum(i.total - i.paid_amount)
                 FILTER (WHERE i.status IN ('issued', 'sent', 'partial')), 0)   AS unpaid_amount,
        COALESCE(sum(i.paid_amount), 0)                                         AS paid_total,
        max(i.paid_at)                                                          AS last_paid_at
    FROM invoices i
    WHERE i.organization_id = o.id AND i.status <> 'void'
) inv ON TRUE;


-- =========================================================
-- 7. 月次請求書の一括生成
--    請求書払い / OEM の稼働中テナントで、その月の請求がまだ無いものを作る。
--    (Stripe 契約は Stripe が請求するのでここでは作らない)
-- =========================================================
CREATE OR REPLACE FUNCTION generate_monthly_invoices(p_month DATE DEFAULT NULL)
RETURNS JSONB AS $$
DECLARE
    v_month   DATE := date_trunc('month', COALESCE(p_month, CURRENT_DATE))::DATE;
    v_seq     INTEGER;
    v_created INTEGER := 0;
    v_skipped INTEGER := 0;
    v_no_price TEXT[] := '{}';
    rec       RECORD;
    v_no      TEXT;
BEGIN
    SELECT COALESCE(max(substring(invoice_no from '\d+$')::INTEGER), 0)
      INTO v_seq
      FROM invoices
     WHERE invoice_no LIKE 'INV-' || to_char(v_month, 'YYYYMM') || '-%';

    FOR rec IN
        SELECT * FROM v_customer_ledger
        WHERE billing_category IN ('invoice', 'oem')
          AND license_status = 'active'
          AND COALESCE(subscription_status, '') <> 'canceled'
          AND (cancel_effective_date IS NULL OR cancel_effective_date > v_month)
        ORDER BY contract_id
    LOOP
        IF EXISTS (
            SELECT 1 FROM invoices
            WHERE organization_id = rec.organization_id
              AND billing_month = v_month
              AND status <> 'void'
        ) THEN
            v_skipped := v_skipped + 1;
            CONTINUE;
        END IF;

        -- プラン未設定などで単価が引けない顧客に ¥0 の請求書を作ってしまわない
        IF COALESCE(rec.monthly_amount, 0) <= 0 THEN
            v_no_price := v_no_price || rec.contract_id;
            CONTINUE;
        END IF;

        v_seq := v_seq + 1;
        v_no := 'INV-' || to_char(v_month, 'YYYYMM') || '-'
                || lpad(v_seq::TEXT, 4, '0');

        INSERT INTO invoices (
            invoice_no, organization_id, contract_id, shop_name, company_name,
            billing_email, billing_category, billing_month, issue_date, due_date,
            plan, qty, unit_price, referrer_code, agency_fee
        ) VALUES (
            v_no, rec.organization_id, rec.contract_id, rec.shop_name, rec.company_name,
            rec.billing_email, rec.billing_category, v_month, CURRENT_DATE,
            CURRENT_DATE + COALESCE(rec.payment_terms_days, 30),
            rec.plan, 1, rec.monthly_amount, rec.referrer_code, rec.agency_fee_monthly
        );
        v_created := v_created + 1;
    END LOOP;

    RETURN jsonb_build_object(
        'success', true,
        'month', to_char(v_month, 'YYYY-MM'),
        'created', v_created,
        'skipped', v_skipped,
        'no_price_count', COALESCE(array_length(v_no_price, 1), 0),
        'no_price_contracts', to_jsonb(v_no_price)
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp;


-- =========================================================
-- 8. 入金消込 (スプレッドシート → システムへの書き戻し)
--    invoice_no をキーに入金日・入金額・振込名義を記録。
--    金額と状態はトリガが確定するので、ここでは値を入れるだけでよい。
-- =========================================================
CREATE OR REPLACE FUNCTION record_invoice_payment(
    p_invoice_no     TEXT,
    p_paid_at        DATE,
    p_paid_amount    NUMERIC,
    p_payment_method TEXT DEFAULT 'bank',
    p_payer_name     TEXT DEFAULT '',
    p_note           TEXT DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
    v_row invoices%ROWTYPE;
BEGIN
    UPDATE invoices
       SET paid_at        = p_paid_at,
           paid_amount    = COALESCE(p_paid_amount, 0),
           payment_method = COALESCE(NULLIF(p_payment_method, ''), payment_method),
           payer_name     = COALESCE(NULLIF(p_payer_name, ''), payer_name),
           note           = COALESCE(p_note, note)
     WHERE invoice_no = p_invoice_no
       AND status <> 'void'
    RETURNING * INTO v_row;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'invoice_no', p_invoice_no,
                                  'message', '請求書が見つかりません(または無効化済み)');
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'invoice_no', v_row.invoice_no,
        'status', v_row.status,
        'total', v_row.total,
        'paid_amount', v_row.paid_amount,
        'balance', v_row.total - v_row.paid_amount
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp;


-- =========================================================
-- 9. 顧客の代理店設定を書き戻す (スプレッドシート → システム)
-- =========================================================
CREATE OR REPLACE FUNCTION update_customer_agency(
    p_contract_id  TEXT,
    p_referrer_code TEXT DEFAULT NULL,
    p_fee_type     TEXT DEFAULT NULL,
    p_fee_amount   NUMERIC DEFAULT NULL,
    p_billing_email TEXT DEFAULT NULL,
    p_payment_terms_days INTEGER DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
    -- NULL      = この項目は変更しない
    -- ''(空文字) = 紹介者の紐付けを **解除** する
    -- それ以外   = そのコードに変更する
    v_code TEXT := CASE WHEN p_referrer_code IS NULL THEN NULL
                        ELSE upper(trim(p_referrer_code)) END;
BEGIN
    IF p_fee_type IS NOT NULL
       AND lower(p_fee_type) NOT IN ('inherit', 'fixed', 'percent', 'none') THEN
        RETURN jsonb_build_object('success', false, 'contract_id', p_contract_id,
                                  'message', 'fee_type が不正です');
    END IF;

    -- 存在しない紹介者コードを黙って書き込むと集計から消えるので弾く
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
           payment_terms_days  = COALESCE(p_payment_terms_days, payment_terms_days)
     WHERE contract_id = p_contract_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'contract_id', p_contract_id,
                                  'message', '契約IDが見つかりません');
    END IF;
    RETURN jsonb_build_object('success', true, 'contract_id', p_contract_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp;


-- =========================================================
-- 10. お問い合わせ × 顧客 の突合
--     「フォームから来たのに顧客化されていない」「顧客なのに問い合わせ記録が無い」
--     を検出する。メール/電話/会社名を正規化して照合する。
-- =========================================================
CREATE OR REPLACE FUNCTION norm_key(p TEXT)
RETURNS TEXT AS $$
    -- 空白(全角含む)・括弧・各種ハイフンを落として突合キーにする
    SELECT NULLIF(regexp_replace(lower(COALESCE(p, '')), '[-\s　()（）ー―‐]', '', 'g'), '');
$$ LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, public, pg_temp;

CREATE OR REPLACE FUNCTION reconcile_inquiries()
RETURNS JSONB AS $$
DECLARE
    v_result JSONB;
BEGIN
    WITH cust AS (
        SELECT organization_id, contract_id, shop_name, company_name, billing_email,
               phone, contact_phone, referrer_code, created_at,
               norm_key(billing_email) AS k_email,
               norm_key(phone)         AS k_phone,
               norm_key(contact_phone) AS k_phone2,
               norm_key(company_name)  AS k_company,
               norm_key(shop_name)     AS k_shop
        FROM v_customer_ledger
    ),
    inq AS (
        SELECT i.id, i.company_name, i.business_name, i.email, i.phone, i.contact_phone,
               i.contact_name, i.status, i.referrer_code, i.created_at,
               norm_key(i.email)         AS k_email,
               norm_key(i.phone)         AS k_phone,
               norm_key(i.contact_phone) AS k_phone2,
               norm_key(i.company_name)  AS k_company,
               norm_key(i.business_name) AS k_business
        FROM inquiries i
    ),
    matched AS (
        SELECT q.id AS inquiry_id, c.contract_id, c.organization_id,
               CASE
                   WHEN q.k_email IS NOT NULL AND q.k_email = c.k_email THEN 'email'
                   WHEN q.k_phone IS NOT NULL
                        AND q.k_phone IN (c.k_phone, c.k_phone2) THEN 'phone'
                   WHEN q.k_phone2 IS NOT NULL
                        AND q.k_phone2 IN (c.k_phone, c.k_phone2) THEN 'phone'
                   ELSE 'company'
               END AS match_by,
               row_number() OVER (
                   PARTITION BY q.id
                   ORDER BY CASE
                       WHEN q.k_email IS NOT NULL AND q.k_email = c.k_email THEN 1
                       WHEN q.k_phone IS NOT NULL
                            AND q.k_phone IN (c.k_phone, c.k_phone2) THEN 2
                       WHEN q.k_phone2 IS NOT NULL
                            AND q.k_phone2 IN (c.k_phone, c.k_phone2) THEN 2
                       ELSE 3 END,
                       c.created_at
               ) AS rn
        FROM inq q
        JOIN cust c ON (
               (q.k_email  IS NOT NULL AND q.k_email  = c.k_email)
            OR (q.k_phone  IS NOT NULL AND q.k_phone  IN (c.k_phone, c.k_phone2))
            OR (q.k_phone2 IS NOT NULL AND q.k_phone2 IN (c.k_phone, c.k_phone2))
            OR (q.k_company IS NOT NULL AND q.k_company IN (c.k_company, c.k_shop))
            OR (q.k_business IS NOT NULL AND q.k_business IN (c.k_company, c.k_shop))
        )
    ),
    best AS (SELECT * FROM matched WHERE rn = 1)
    SELECT jsonb_build_object(
        'inquiries', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'inquiry_id',   q.id,
                'company_name', q.company_name,
                'business_name', q.business_name,
                'contact_name', q.contact_name,
                'email',        q.email,
                'phone',        q.phone,
                'inquiry_status', q.status,
                'referrer_code', upper(trim(COALESCE(q.referrer_code, ''))),
                'created_at',   q.created_at,
                'matched_contract_id', b.contract_id,
                'match_by',     b.match_by,
                -- 未契約のまま放置されている見込み客 = 対応漏れ
                'is_orphan',    (b.contract_id IS NULL)
            ) ORDER BY q.created_at DESC)
            FROM inq q LEFT JOIN best b ON b.inquiry_id = q.id
        ), '[]'::jsonb),
        'customers_without_inquiry', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'contract_id',  c.contract_id,
                'shop_name',    c.shop_name,
                'company_name', c.company_name,
                'billing_email', c.billing_email,
                'referrer_code', c.referrer_code,
                'created_at',   c.created_at
            ) ORDER BY c.created_at DESC)
            FROM cust c
            WHERE NOT EXISTS (SELECT 1 FROM best b WHERE b.contract_id = c.contract_id)
        ), '[]'::jsonb),
        'referrer_mismatch', COALESCE((
            -- 問い合わせ時の紹介者コードと契約後の紹介者コードが食い違う = 報酬の付け漏れ
            SELECT jsonb_agg(jsonb_build_object(
                'contract_id',  c.contract_id,
                'shop_name',    c.shop_name,
                'inquiry_referrer',  upper(trim(COALESCE(q.referrer_code, ''))),
                'customer_referrer', c.referrer_code
            ))
            FROM best b
            JOIN inq q  ON q.id = b.inquiry_id
            JOIN cust c ON c.contract_id = b.contract_id
            WHERE NULLIF(upper(trim(COALESCE(q.referrer_code, ''))), '') IS DISTINCT FROM
                  NULLIF(c.referrer_code, '')
        ), '[]'::jsonb)
    ) INTO v_result;

    RETURN v_result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp;


-- =========================================================
-- 11. 代理店(紹介者)フィーの月次確定集計
--     invoices に確定済みの agency_fee を紹介者ごとに合算する。
--     「入金済みのみ支払い対象」を運営が判断できるよう両方返す。
-- =========================================================
CREATE OR REPLACE FUNCTION list_agency_fees(p_month DATE DEFAULT NULL)
RETURNS JSONB AS $$
DECLARE
    v_month DATE := date_trunc('month', COALESCE(p_month, CURRENT_DATE))::DATE;
BEGIN
    RETURN COALESCE((
        SELECT jsonb_agg(x ORDER BY x->>'referrer_code')
        FROM (
            SELECT jsonb_build_object(
                'month',            to_char(v_month, 'YYYY-MM'),
                'referrer_code',    upper(trim(i.referrer_code)),
                'referrer_name',    COALESCE(r.name, ''),
                'company_name',     COALESCE(r.company_name, ''),
                'commission_type',  COALESCE(r.commission_type, 'percent'),
                'commission_rate',  COALESCE(r.commission_rate, 0),
                'commission_amount', COALESCE(r.commission_amount, 0),
                'bank_account',     COALESCE(r.bank_account, ''),
                'client_count',     count(*),
                'billed_amount',    COALESCE(sum(i.total), 0),
                'paid_amount',      COALESCE(sum(i.paid_amount), 0),
                'fee_total',        COALESCE(sum(i.agency_fee), 0),
                'fee_payable',      COALESCE(sum(i.agency_fee) FILTER (WHERE i.status = 'paid'), 0),
                'fee_pending',      COALESCE(sum(i.agency_fee) FILTER (WHERE i.status <> 'paid'), 0)
            ) AS x
            FROM invoices i
            LEFT JOIN referrers r ON upper(trim(r.code)) = upper(trim(i.referrer_code))
            WHERE i.billing_month = v_month
              AND i.status <> 'void'
              AND trim(COALESCE(i.referrer_code, '')) <> ''
            GROUP BY upper(trim(i.referrer_code)), r.name, r.company_name,
                     r.commission_type, r.commission_rate, r.commission_amount, r.bank_account
        ) s
    ), '[]'::jsonb);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp;


-- =========================================================
-- 11-b. 一覧取得は必ず JSONB 単一値で返す
--
--   PostgREST は行を返す経路に max-rows=1000 を適用するため、テーブル/ビューを
--   REST で直接読むと 1001件目以降が「エラーにならず静かに欠落」する。
--   (migration 74 / 75 で list_shifts / list_requests が同じ問題を起こしていた)
--   請求台帳・顧客台帳・お問い合わせは件数が増え続けるので、最初から
--   jsonb_agg の単一値で返す。単一 JSONB 値には行数制限が適用されない。
-- =========================================================

CREATE OR REPLACE FUNCTION list_invoices(
    p_from DATE DEFAULT NULL,
    p_to   DATE DEFAULT NULL
) RETURNS JSONB AS $$
    SELECT COALESCE(jsonb_agg(to_jsonb(i) ORDER BY i.billing_month DESC, i.invoice_no), '[]'::jsonb)
    FROM invoices i
    WHERE (p_from IS NULL OR i.billing_month >= date_trunc('month', p_from)::DATE)
      AND (p_to   IS NULL OR i.billing_month <= date_trunc('month', p_to)::DATE);
$$ LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp;

CREATE OR REPLACE FUNCTION list_customer_ledger()
RETURNS JSONB AS $$
    SELECT COALESCE(jsonb_agg(to_jsonb(c) ORDER BY c.created_at DESC), '[]'::jsonb)
    FROM v_customer_ledger c;
$$ LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp;

-- to_jsonb(i) なので、お問い合わせフォームに項目が増えても自動で全カラム返る
CREATE OR REPLACE FUNCTION list_inquiries_all()
RETURNS JSONB AS $$
    SELECT COALESCE(jsonb_agg(to_jsonb(i) ORDER BY i.created_at DESC), '[]'::jsonb)
    FROM inquiries i;
$$ LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp;

-- 全テナントのスタッフ数。config/staff を REST で読むと同じく1000件で切れるため。
CREATE OR REPLACE FUNCTION list_staff_counts()
RETURNS JSONB AS $$
    SELECT COALESCE(jsonb_object_agg(organization_id, cnt), '{}'::jsonb)
    FROM (
        SELECT organization_id, count(*) AS cnt
        FROM staff
        WHERE organization_id IS NOT NULL
        GROUP BY organization_id
    ) s;
$$ LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp;


-- =========================================================
-- 12. 権限
--     いずれも運営バックエンド(service_role)からのみ呼ぶ。
--     anon へは公開しない (顧客の請求情報が読めてしまうため)。
--
--     重要: PostgreSQL は新規関数の EXECUTE を **PUBLIC に既定付与**する。
--     anon/authenticated から REVOKE しても PUBLIC 経由で実行できてしまうため、
--     必ず PUBLIC から剥奪する (migration 71 と同じ理由)。
-- =========================================================
REVOKE EXECUTE ON FUNCTION generate_monthly_invoices(DATE)   FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION record_invoice_payment(TEXT, DATE, NUMERIC, TEXT, TEXT, TEXT)
                                                             FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION update_customer_agency(TEXT, TEXT, TEXT, NUMERIC, TEXT, INTEGER)
                                                             FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION reconcile_inquiries()             FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION list_agency_fees(DATE)            FROM PUBLIC, anon, authenticated;
-- invoices_recalc はトリガ関数のため権限を触らない (INSERT/UPDATE が壊れるのを避ける)
-- get_plan_price / resolve_agency_fee / norm_key は機密を返さないが、
-- 経路を揃えるため同様に service_role 限定にする
REVOKE EXECUTE ON FUNCTION get_plan_price(TEXT)              FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION resolve_agency_fee(TEXT, TEXT, TEXT, NUMERIC, NUMERIC)
                                                             FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION norm_key(TEXT)                    FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION list_invoices(DATE, DATE)         FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION list_customer_ledger()            FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION list_inquiries_all()              FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION list_staff_counts()               FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE v_customer_ledger                        FROM anon, authenticated;

GRANT SELECT ON TABLE v_customer_ledger TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE invoices TO service_role;
GRANT EXECUTE ON FUNCTION generate_monthly_invoices(DATE) TO service_role;
GRANT EXECUTE ON FUNCTION record_invoice_payment(TEXT, DATE, NUMERIC, TEXT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION update_customer_agency(TEXT, TEXT, TEXT, NUMERIC, TEXT, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION reconcile_inquiries() TO service_role;
GRANT EXECUTE ON FUNCTION list_agency_fees(DATE) TO service_role;
GRANT EXECUTE ON FUNCTION get_plan_price(TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION resolve_agency_fee(TEXT, TEXT, TEXT, NUMERIC, NUMERIC) TO service_role;
GRANT EXECUTE ON FUNCTION norm_key(TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION list_invoices(DATE, DATE) TO service_role;
GRANT EXECUTE ON FUNCTION list_customer_ledger() TO service_role;
GRANT EXECUTE ON FUNCTION list_inquiries_all() TO service_role;
GRANT EXECUTE ON FUNCTION list_staff_counts() TO service_role;

-- GAS連携用APIキー (運営管理画面の設定タブから登録する)
INSERT INTO platform_settings (key, value, description) VALUES
    ('gas_api_key', '', 'GASスプレッドシート連携用APIキー (32文字以上のランダム文字列)')
ON CONFLICT (key) DO NOTHING;

NOTIFY pgrst, 'reload schema';
