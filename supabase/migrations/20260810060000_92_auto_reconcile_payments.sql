-- =========================================================
-- 92_auto_reconcile_payments.sql   (v3.7.287)
--
-- 入金消込の自動化。ここが自動化できないと運用から人手が消えない。
--
--   1) 入金明細 (bank_transactions) を受け取る器
--   2) 金額 + 振込名義で未入金の請求書に自動照合する
--   3) 判断が割れるものだけ「要確認」として人に回す
--   4) 支払督促を自動で送るための記録
--
-- 自動消込の条件 (誤消込を出さないための線引き):
--   - 金額が請求残額と完全一致
--   - かつ 振込名義が その顧客の名義候補と一致
--     (過去に消し込んだ名義 / 会社名 / 店舗名 を正規化して比較)
--   - 名義が一致しなくても、金額一致の候補が「1件だけ」なら消し込む
--   - 候補が複数ある場合は消し込まず要確認に回す
-- =========================================================

-- =========================================================
-- 1. 入金明細
-- =========================================================
CREATE TABLE IF NOT EXISTS bank_transactions (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    paid_on       DATE NOT NULL,
    amount        NUMERIC(12,2) NOT NULL,
    payer_name    TEXT NOT NULL DEFAULT '',      -- 振込名義 (銀行明細のまま)
    memo          TEXT NOT NULL DEFAULT '',      -- 摘要
    source        TEXT NOT NULL DEFAULT 'csv',   -- csv | mail | manual
    fingerprint   TEXT UNIQUE,                   -- 同じ明細を二重取込しないための指紋
    matched_invoice_no TEXT,
    match_status  TEXT NOT NULL DEFAULT 'pending', -- pending|matched|ambiguous|unmatched|ignored
    match_note    TEXT NOT NULL DEFAULT '',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    matched_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_bank_tx_status ON bank_transactions(match_status);
CREATE INDEX IF NOT EXISTS idx_bank_tx_paid_on ON bank_transactions(paid_on DESC);

ALTER TABLE bank_transactions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "bank_tx_no_direct" ON bank_transactions;
CREATE POLICY "bank_tx_no_direct" ON bank_transactions FOR ALL TO anon USING (false) WITH CHECK (false);

-- 督促の記録 (何度も送らないため)
ALTER TABLE invoices
    ADD COLUMN IF NOT EXISTS reminder_sent_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS reminder_count INTEGER NOT NULL DEFAULT 0;


-- =========================================================
-- 2. 振込名義の正規化
--    「カ)モチクロ」「カブシキガイシャモチクロ」「(カ)モチクロ」等を寄せる。
--    半角カナ→全角、記号と空白を除去、法人格の略号を落とす。
-- =========================================================
CREATE OR REPLACE FUNCTION norm_payer(p TEXT)
RETURNS TEXT AS $$
DECLARE
    v TEXT;
BEGIN
    v := upper(COALESCE(p, ''));
    -- 半角カナを全角へ (よく使われる範囲のみ)
    v := translate(v,
         'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜｦﾝｧｨｩｪｫｯｬｭｮ',
         'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲンァィゥェォッャュョ');
    -- 濁点・半濁点を合成しないまま残さない
    v := replace(replace(v, 'ﾞ', '゛'), 'ﾟ', '゜');
    -- 法人格の表記ゆれを除去
    v := regexp_replace(v, '(カブシキガイシャ|ユウゲンガイシャ|ゴウドウガイシャ|株式会社|有限会社|合同会社)', '', 'g');
    v := regexp_replace(v, '[（(]?[カユド][)）]', '', 'g');
    -- 記号・空白をすべて落とす
    v := regexp_replace(v, '[[:space:]　\-ー―‐・.,''"()（）]', '', 'g');
    RETURN NULLIF(v, '');
END;
$$ LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog, public, pg_temp;


-- =========================================================
-- 3. 入金明細の取り込み
--    fingerprint で二重取込を防ぐ。同じ内容を何度貼っても増えない。
-- =========================================================
CREATE OR REPLACE FUNCTION import_bank_transaction(
    p_paid_on DATE,
    p_amount NUMERIC,
    p_payer_name TEXT DEFAULT '',
    p_memo TEXT DEFAULT '',
    p_source TEXT DEFAULT 'csv'
) RETURNS JSONB AS $$
DECLARE
    v_fp TEXT;
    v_id UUID;
BEGIN
    IF p_paid_on IS NULL OR COALESCE(p_amount, 0) <= 0 THEN
        RETURN jsonb_build_object('success', false, 'message', '日付と金額が必要です');
    END IF;

    v_fp := md5(p_paid_on::TEXT || '|' || p_amount::TEXT || '|'
                || COALESCE(norm_payer(p_payer_name), '') || '|' || COALESCE(p_memo, ''));

    INSERT INTO bank_transactions (paid_on, amount, payer_name, memo, source, fingerprint)
    VALUES (p_paid_on, p_amount, COALESCE(p_payer_name, ''), COALESCE(p_memo, ''),
            COALESCE(NULLIF(p_source, ''), 'csv'), v_fp)
    ON CONFLICT (fingerprint) DO NOTHING
    RETURNING id INTO v_id;

    IF v_id IS NULL THEN
        RETURN jsonb_build_object('success', true, 'duplicated', true);
    END IF;
    RETURN jsonb_build_object('success', true, 'id', v_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp;


-- =========================================================
-- 4. 自動照合
--    未処理の入金明細を、未入金の請求書に突き合わせる。
-- =========================================================
CREATE OR REPLACE FUNCTION auto_match_payments(p_days INTEGER DEFAULT 90)
RETURNS JSONB AS $$
DECLARE
    tx        RECORD;
    cand      RECORD;
    v_cnt     INTEGER;
    v_matched INTEGER := 0;
    v_ambig   INTEGER := 0;
    v_none    INTEGER := 0;
    v_list    JSONB := '[]'::jsonb;
    v_amb     JSONB := '[]'::jsonb;
    v_inv     TEXT;
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

        -- ① 金額一致 かつ 名義一致 (最も確実)
        SELECT count(*), min(i.invoice_no) INTO v_cnt, v_inv
          FROM invoices i
         WHERE i.status IN ('issued', 'sent', 'partial')
           AND (i.total - i.paid_amount) = tx.amount
           AND norm_payer(tx.payer_name) IS NOT NULL
           AND norm_payer(tx.payer_name) IN (
                 COALESCE(norm_payer(i.payer_name), ''),
                 COALESCE(norm_payer(i.company_name), ''),
                 COALESCE(norm_payer(i.shop_name), ''),
                 -- 同じ顧客の過去の消込名義も候補にする (一度覚えたら次から確実に当たる)
                 COALESCE((SELECT norm_payer(p.payer_name) FROM invoices p
                            WHERE p.contract_id = i.contract_id
                              AND p.payer_name <> '' AND p.status = 'paid'
                            ORDER BY p.paid_at DESC NULLS LAST LIMIT 1), '')
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
            PERFORM record_invoice_payment(v_inv, tx.paid_on, tx.amount, 'bank', tx.payer_name, NULL);
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
                   match_note = '同額の未入金が ' || v_cnt || ' 件あり自動判定できません'
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


-- =========================================================
-- 5. 一覧 / 手動での紐付け直し
-- =========================================================
CREATE OR REPLACE FUNCTION list_bank_transactions(p_days INTEGER DEFAULT 180)
RETURNS JSONB AS $$
    SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t.paid_on DESC, t.created_at DESC), '[]'::jsonb)
    FROM bank_transactions t
    WHERE t.paid_on >= (now() AT TIME ZONE 'Asia/Tokyo')::DATE - p_days;
$$ LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp;

/** 要確認の明細を、運営が選んだ請求書に手で紐付ける */
CREATE OR REPLACE FUNCTION assign_bank_transaction(p_tx_id UUID, p_invoice_no TEXT)
RETURNS JSONB AS $$
DECLARE tx RECORD; res JSONB;
BEGIN
    SELECT * INTO tx FROM bank_transactions WHERE id = p_tx_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'message', '入金明細が見つかりません');
    END IF;
    res := record_invoice_payment(p_invoice_no, tx.paid_on, tx.amount, 'bank', tx.payer_name, NULL);
    IF (res->>'success')::BOOLEAN IS NOT TRUE THEN
        RETURN res;
    END IF;
    UPDATE bank_transactions
       SET match_status = 'matched', matched_invoice_no = p_invoice_no,
           match_note = 'manual', matched_at = now()
     WHERE id = p_tx_id;
    RETURN jsonb_build_object('success', true, 'invoice_no', p_invoice_no);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp;


-- =========================================================
-- 6. 督促対象の抽出
--    期日を過ぎた未入金で、まだ督促していない (または前回から間隔が空いた) もの。
-- =========================================================
CREATE OR REPLACE FUNCTION list_overdue_for_reminder(
    p_grace_days INTEGER DEFAULT 1,
    p_interval_days INTEGER DEFAULT 7,
    p_max_count INTEGER DEFAULT 3
) RETURNS JSONB AS $$
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'invoice_no', i.invoice_no,
        'contract_id', i.contract_id,
        'shop_name', i.shop_name,
        'company_name', i.company_name,
        'billing_email', i.billing_email,
        'period_start', i.period_start,
        'period_end', i.period_end,
        'issue_date', i.issue_date,
        'due_date', i.due_date,
        'total', i.total,
        'balance', i.total - i.paid_amount,
        'reminder_count', i.reminder_count,
        'days_overdue', ((now() AT TIME ZONE 'Asia/Tokyo')::DATE - i.due_date)
    ) ORDER BY i.due_date), '[]'::jsonb)
    FROM invoices i
    WHERE i.status IN ('issued', 'sent', 'partial')
      AND i.due_date IS NOT NULL
      AND i.due_date < (now() AT TIME ZONE 'Asia/Tokyo')::DATE - p_grace_days
      AND i.reminder_count < p_max_count
      AND (i.reminder_sent_at IS NULL
           OR i.reminder_sent_at < now() - (p_interval_days || ' days')::INTERVAL)
      AND trim(COALESCE(i.billing_email, '')) <> '';
$$ LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp;

CREATE OR REPLACE FUNCTION mark_reminder_sent(p_invoice_nos TEXT[])
RETURNS JSONB AS $$
DECLARE v_n INTEGER;
BEGIN
    UPDATE invoices
       SET reminder_sent_at = now(), reminder_count = reminder_count + 1
     WHERE invoice_no = ANY(p_invoice_nos);
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RETURN jsonb_build_object('success', true, 'updated', v_n);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp;


-- =========================================================
-- 7. 権限
-- =========================================================
REVOKE EXECUTE ON FUNCTION norm_payer(TEXT)                       FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION import_bank_transaction(DATE, NUMERIC, TEXT, TEXT, TEXT)
                                                                   FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION auto_match_payments(INTEGER)           FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION list_bank_transactions(INTEGER)        FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION assign_bank_transaction(UUID, TEXT)    FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION list_overdue_for_reminder(INTEGER, INTEGER, INTEGER)
                                                                   FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION mark_reminder_sent(TEXT[])             FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, UPDATE ON TABLE bank_transactions TO service_role;
GRANT EXECUTE ON FUNCTION norm_payer(TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION import_bank_transaction(DATE, NUMERIC, TEXT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION auto_match_payments(INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION list_bank_transactions(INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION assign_bank_transaction(UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION list_overdue_for_reminder(INTEGER, INTEGER, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION mark_reminder_sent(TEXT[]) TO service_role;

NOTIFY pgrst, 'reload schema';
