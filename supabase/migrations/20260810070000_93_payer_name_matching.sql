-- =========================================================
-- 93_payer_name_matching.sql   (v3.7.287)
--
-- 振込名義の照合が実務で当たらない問題の修正。
--
-- ① 半角カナの濁点が分離したままだった
--    'ｼﾞ' を全角化すると 'シ' + '゛' の2文字になり、'ジ'(1文字) と一致しない。
--    日本の銀行CSVは半角カナが標準なので、これでは名義照合がほぼ当たらない。
--    → 濁点・半濁点は清音に寄せてから比較する (シ゛ も ジ も 'シ' になる)。
--
-- ② 振込名義が漢字社名と一致しない
--    振込名義はカナ、会社名は漢字なので初回は必ず「要確認」になる。
--    → 顧客ごとに振込名義を事前登録できるようにし、初回から自動消込できるようにする。
--    → 手で紐付けたときはその名義を自動で学習し、次回から当たるようにする。
-- =========================================================

-- =========================================================
-- 1. 顧客ごとの振込名義 (複数登録可)
-- =========================================================
ALTER TABLE config
    ADD COLUMN IF NOT EXISTS payer_names TEXT[] DEFAULT '{}';


-- =========================================================
-- 2. 正規化の修正
-- =========================================================
CREATE OR REPLACE FUNCTION norm_payer(p TEXT)
RETURNS TEXT AS $$
DECLARE
    v TEXT;
BEGIN
    v := upper(COALESCE(p, ''));

    -- 半角カナ → 全角カナ (清音の対応表)
    v := translate(v,
         'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜｦﾝｧｨｩｪｫｯｬｭｮｰ',
         'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲンアイウエオツヤユヨー');

    -- 濁点・半濁点は清音へ寄せる。
    -- 半角カナは「文字＋濁点記号」の2文字で来るため、合成せずに落とす方が確実。
    v := translate(v,
         'ガギグゲゴザジズゼゾダヂヅデドバビブベボパピプペポヴ',
         'カキクケコサシスセソタチツテトハヒフヘホハヒフヘホウ');
    v := regexp_replace(v, '[ﾞﾟ゛゜]', '', 'g');

    -- 小書き文字を大書きへ (ｷﾔ と キャ を同一視)
    v := translate(v, 'ァィゥェォッャュョヮ', 'アイウエオツヤユヨワ');

    -- 法人格の表記ゆれを除去
    v := regexp_replace(v, '(カフシキカイシヤ|カブシキガイシャ|ユウケンカイシヤ|ユウゲンガイシャ|コウトウカイシヤ|ゴウドウガイシャ|株式会社|有限会社|合同会社)', '', 'g');
    v := regexp_replace(v, '[（(]?[カユド][)）]', '', 'g');

    -- 記号・空白をすべて落とす
    v := regexp_replace(v, '[[:space:]　\-ー―‐・.,''"()（）]', '', 'g');

    RETURN NULLIF(v, '');
END;
$$ LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog, public, pg_temp;


-- =========================================================
-- 3. 顧客台帳ビューに振込名義を出す
-- =========================================================
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
    array_to_string(COALESCE(c.payer_names, '{}'), ' / ') AS payer_names,
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


-- =========================================================
-- 4. 名義の学習
--    消込に使われた名義を顧客に覚えさせ、次回から自動で当たるようにする。
-- =========================================================
CREATE OR REPLACE FUNCTION learn_payer_name(p_contract_id TEXT, p_payer_name TEXT)
RETURNS VOID AS $$
BEGIN
    IF p_contract_id IS NULL OR COALESCE(trim(p_payer_name), '') = '' THEN
        RETURN;
    END IF;
    UPDATE config
       SET payer_names = (
             SELECT array_agg(DISTINCT x)
               FROM unnest(COALESCE(payer_names, '{}') || trim(p_payer_name)) AS x
              WHERE COALESCE(trim(x), '') <> '')
     WHERE contract_id = p_contract_id
       AND NOT EXISTS (
             SELECT 1 FROM unnest(COALESCE(payer_names, '{}')) AS y
              WHERE norm_payer(y) = norm_payer(p_payer_name));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp;


-- =========================================================
-- 5. 自動照合 (事前登録した名義も候補に入れる)
-- =========================================================
CREATE OR REPLACE FUNCTION auto_match_payments(p_days INTEGER DEFAULT 90)
RETURNS JSONB AS $$
DECLARE
    tx        RECORD;
    v_cnt     INTEGER;
    v_matched INTEGER := 0;
    v_ambig   INTEGER := 0;
    v_none    INTEGER := 0;
    v_list    JSONB := '[]'::jsonb;
    v_amb     JSONB := '[]'::jsonb;
    v_inv     TEXT;
    v_cid     TEXT;
    v_by      TEXT;
BEGIN
    FOR tx IN
        SELECT * FROM bank_transactions
         WHERE match_status = 'pending'
           AND paid_on >= (now() AT TIME ZONE 'Asia/Tokyo')::DATE - p_days
         ORDER BY paid_on, id
    LOOP
        v_inv := NULL;
        v_by := NULL;

        -- ① 金額一致 かつ 名義一致
        SELECT count(*), min(i.invoice_no) INTO v_cnt, v_inv
          FROM invoices i
          LEFT JOIN config c ON c.contract_id = i.contract_id
         WHERE i.status IN ('issued', 'sent', 'partial')
           AND (i.total - i.paid_amount) = tx.amount
           AND norm_payer(tx.payer_name) IS NOT NULL
           AND (
                 norm_payer(tx.payer_name) = norm_payer(i.payer_name)
              OR norm_payer(tx.payer_name) = norm_payer(i.company_name)
              OR norm_payer(tx.payer_name) = norm_payer(i.shop_name)
              -- 顧客に登録された振込名義
              OR EXISTS (SELECT 1 FROM unnest(COALESCE(c.payer_names, '{}')) AS pn
                          WHERE norm_payer(pn) = norm_payer(tx.payer_name))
              -- 同じ顧客の過去の消込名義
              OR EXISTS (SELECT 1 FROM invoices p
                          WHERE p.contract_id = i.contract_id
                            AND p.status = 'paid' AND p.payer_name <> ''
                            AND norm_payer(p.payer_name) = norm_payer(tx.payer_name))
               );
        IF v_cnt = 1 THEN
            v_by := 'amount+name';
        ELSE
            v_inv := NULL;
            -- ② 金額一致のみ。候補が1件だけなら消し込む
            SELECT count(*), min(i.invoice_no) INTO v_cnt, v_inv
              FROM invoices i
             WHERE i.status IN ('issued', 'sent', 'partial')
               AND (i.total - i.paid_amount) = tx.amount;
            IF v_cnt = 1 THEN
                v_by := 'amount';
            ELSE
                v_inv := NULL;
            END IF;
        END IF;

        IF v_inv IS NOT NULL THEN
            SELECT contract_id INTO v_cid FROM invoices WHERE invoice_no = v_inv;
            PERFORM record_invoice_payment(v_inv, tx.paid_on, tx.amount, 'bank', tx.payer_name, NULL);
            PERFORM learn_payer_name(v_cid, tx.payer_name);
            UPDATE bank_transactions
               SET match_status = 'matched', matched_invoice_no = v_inv,
                   match_note = v_by, matched_at = now()
             WHERE id = tx.id;
            v_matched := v_matched + 1;
            v_list := v_list || jsonb_build_object('invoice_no', v_inv, 'amount', tx.amount,
                                                   'payer_name', tx.payer_name,
                                                   'paid_on', tx.paid_on, 'matched_by', v_by);
        ELSIF v_cnt > 1 THEN
            UPDATE bank_transactions
               SET match_status = 'ambiguous',
                   match_note = '同額の未入金が ' || v_cnt || ' 件あり、名義でも特定できません'
             WHERE id = tx.id;
            v_ambig := v_ambig + 1;
            v_amb := v_amb || jsonb_build_object('paid_on', tx.paid_on, 'amount', tx.amount,
                                                 'payer_name', tx.payer_name, 'candidates', v_cnt);
        ELSE
            UPDATE bank_transactions
               SET match_status = 'unmatched',
                   match_note = '一致する未入金の請求がありません'
             WHERE id = tx.id;
            v_none := v_none + 1;
        END IF;
    END LOOP;

    RETURN jsonb_build_object(
        'success', true,
        'matched', v_matched, 'ambiguous', v_ambig, 'unmatched', v_none,
        'matched_list', v_list, 'ambiguous_list', v_amb);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp;


-- 手で紐付けたときも名義を覚える
CREATE OR REPLACE FUNCTION assign_bank_transaction(p_tx_id UUID, p_invoice_no TEXT)
RETURNS JSONB AS $$
DECLARE tx RECORD; res JSONB; v_cid TEXT;
BEGIN
    SELECT * INTO tx FROM bank_transactions WHERE id = p_tx_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'message', '入金明細が見つかりません');
    END IF;
    res := record_invoice_payment(p_invoice_no, tx.paid_on, tx.amount, 'bank', tx.payer_name, NULL);
    IF (res->>'success')::BOOLEAN IS NOT TRUE THEN
        RETURN res;
    END IF;
    SELECT contract_id INTO v_cid FROM invoices WHERE invoice_no = p_invoice_no;
    PERFORM learn_payer_name(v_cid, tx.payer_name);   -- 次回から自動で当たるようにする
    UPDATE bank_transactions
       SET match_status = 'matched', matched_invoice_no = p_invoice_no,
           match_note = 'manual', matched_at = now()
     WHERE id = p_tx_id;
    RETURN jsonb_build_object('success', true, 'invoice_no', p_invoice_no);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp;


-- =========================================================
-- 6. 顧客設定の書き戻しに振込名義を追加
-- =========================================================
CREATE OR REPLACE FUNCTION update_customer_agency(
    p_contract_id  TEXT,
    p_referrer_code TEXT DEFAULT NULL,
    p_fee_type     TEXT DEFAULT NULL,
    p_fee_amount   NUMERIC DEFAULT NULL,
    p_billing_email TEXT DEFAULT NULL,
    p_payment_terms_days INTEGER DEFAULT NULL,
    p_billing_start_date DATE DEFAULT NULL,
    p_payer_names  TEXT DEFAULT NULL      -- ' / ' 区切り。空文字で全消し
) RETURNS JSONB AS $$
DECLARE
    v_code TEXT := CASE WHEN p_referrer_code IS NULL THEN NULL
                        ELSE upper(trim(p_referrer_code)) END;
    v_names TEXT[];
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

    IF p_payer_names IS NOT NULL THEN
        SELECT COALESCE(array_agg(trim(x)), '{}')
          INTO v_names
          FROM unnest(string_to_array(p_payer_names, '/')) AS x
         WHERE COALESCE(trim(x), '') <> '';
    END IF;

    UPDATE config
       SET referrer_code       = COALESCE(v_code, referrer_code),
           agency_fee_type     = COALESCE(lower(p_fee_type), agency_fee_type),
           agency_fee_amount   = COALESCE(p_fee_amount, agency_fee_amount),
           billing_email       = COALESCE(p_billing_email, billing_email),
           payment_terms_days  = COALESCE(p_payment_terms_days, payment_terms_days),
           billing_start_date  = COALESCE(p_billing_start_date, billing_start_date),
           payer_names         = COALESCE(v_names, payer_names)
     WHERE contract_id = p_contract_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'contract_id', p_contract_id,
                                  'message', '契約IDが見つかりません');
    END IF;
    RETURN jsonb_build_object('success', true, 'contract_id', p_contract_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp;

DROP FUNCTION IF EXISTS update_customer_agency(TEXT, TEXT, TEXT, NUMERIC, TEXT, INTEGER, DATE);


-- =========================================================
-- 7. 権限
-- =========================================================
REVOKE EXECUTE ON FUNCTION norm_payer(TEXT)                   FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION learn_payer_name(TEXT, TEXT)       FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION auto_match_payments(INTEGER)       FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION assign_bank_transaction(UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION update_customer_agency(TEXT, TEXT, TEXT, NUMERIC, TEXT, INTEGER, DATE, TEXT)
                                                              FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION norm_payer(TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION learn_payer_name(TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION auto_match_payments(INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION assign_bank_transaction(UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION update_customer_agency(TEXT, TEXT, TEXT, NUMERIC, TEXT, INTEGER, DATE, TEXT) TO service_role;

NOTIFY pgrst, 'reload schema';
