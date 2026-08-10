-- =========================================================
-- 98_payment_allocation.sql   (v3.7.287)
--
-- 入金が請求の残額を超えたときに、超過分が消える問題の修正。
--
-- 96 は名義で顧客が1社に定まると「最も古い請求」1件に全額を充てていた。
-- 同じ顧客の2ヶ月分をまとめて1本で振り込む運用は普通にあり、その場合
--   ・古い方の paid_amount が請求額を超える (完済扱い)
--   ・新しい方は未入金のまま残り、翌朝そのまま督促が飛ぶ
-- という、払った顧客に督促を送る状態になっていた。
--
-- 入金は古い順に、各請求の残額を上限として按分する。
-- 充当しきれない分は前受けとして、どの請求にも足さずに記録だけ残す
-- (どこかの請求に押し込むと、その請求が過入金になり同じ問題に戻る)。
--
-- あわせて、3箇所に写経されていた名義照合の条件を関数に切り出す。
-- 条件が食い違うと「照合できるのに消し込めない」状態になるため。
-- =========================================================

-- =========================================================
-- 1. 名義が一致する未入金の請求
-- =========================================================
CREATE OR REPLACE FUNCTION payer_matched_invoices(p_payer TEXT)
RETURNS TABLE (
    m_invoice_no  TEXT,
    m_contract_id TEXT,
    m_balance     NUMERIC,
    m_period_start DATE,
    m_issue_date  DATE
) AS $$
    SELECT i.invoice_no, i.contract_id, (i.total - i.paid_amount),
           i.period_start, i.issue_date
      FROM invoices i
      LEFT JOIN config c ON c.contract_id = i.contract_id
     WHERE i.status IN ('issued', 'sent', 'partial')
       AND norm_payer(p_payer) IS NOT NULL
       AND (
             norm_payer(p_payer) = norm_payer(i.payer_name)
          OR norm_payer(p_payer) = norm_payer(i.company_name)
          OR norm_payer(p_payer) = norm_payer(i.shop_name)
          -- 顧客に登録された振込名義
          OR EXISTS (SELECT 1 FROM unnest(COALESCE(c.payer_names, '{}')) AS pn
                      WHERE norm_payer(pn) = norm_payer(p_payer))
          -- 同じ顧客の過去の消込名義
          OR EXISTS (SELECT 1 FROM invoices p
                      WHERE p.contract_id = i.contract_id
                        AND p.status = 'paid' AND p.payer_name <> ''
                        AND norm_payer(p.payer_name) = norm_payer(p_payer))
           );
$$ LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp;


-- =========================================================
-- 2. 自動照合 (古い順に按分)
-- =========================================================
CREATE OR REPLACE FUNCTION auto_match_payments(p_days INTEGER DEFAULT 90)
RETURNS JSONB AS $$
DECLARE
    tx        RECORD;
    cand      RECORD;
    v_cust    INTEGER;   -- 候補が何社にまたがるか
    v_cnt     INTEGER;
    v_matched INTEGER := 0;
    v_ambig   INTEGER := 0;
    v_none    INTEGER := 0;
    v_over    INTEGER := 0;
    v_list    JSONB := '[]'::jsonb;
    v_amb     JSONB := '[]'::jsonb;
    v_inv     TEXT;
    v_cid     TEXT;
    v_by      TEXT;
    v_left    NUMERIC;
    v_apply   NUMERIC;
    v_nos     TEXT[];
    v_note    TEXT;
BEGIN
    FOR tx IN
        SELECT * FROM bank_transactions
         WHERE match_status = 'pending'
           AND paid_on >= (now() AT TIME ZONE 'Asia/Tokyo')::DATE - p_days
         ORDER BY paid_on, id
    LOOP
        v_inv := NULL; v_by := NULL; v_cnt := 0; v_cust := 0;
        v_nos := '{}'; v_note := ''; v_left := 0;

        SELECT count(DISTINCT m_contract_id), count(*) INTO v_cust, v_cnt
          FROM payer_matched_invoices(tx.payer_name);

        IF v_cust = 1 THEN
            -- 顧客が1社に定まった。残額が一致する請求があればそれ1件に充てる。
            SELECT m_invoice_no INTO v_inv
              FROM payer_matched_invoices(tx.payer_name)
             WHERE m_balance = tx.amount
             ORDER BY m_period_start NULLS LAST, m_issue_date
             LIMIT 1;

            IF v_inv IS NOT NULL THEN
                v_by := 'amount+name';
                SELECT contract_id INTO v_cid FROM invoices WHERE invoice_no = v_inv;
                PERFORM add_invoice_payment(v_inv, tx.paid_on, tx.amount, 'bank', tx.payer_name, NULL);
                PERFORM learn_payer_name(v_cid, tx.payer_name);
                v_nos := ARRAY[v_inv];
            ELSE
                -- 古い順に、各請求の残額を上限として按分する
                v_left := tx.amount;
                FOR cand IN
                    SELECT * FROM payer_matched_invoices(tx.payer_name)
                     ORDER BY m_period_start NULLS LAST, m_issue_date
                LOOP
                    EXIT WHEN v_left <= 0;
                    v_apply := LEAST(v_left, cand.m_balance);
                    CONTINUE WHEN v_apply <= 0;
                    PERFORM add_invoice_payment(cand.m_invoice_no, tx.paid_on, v_apply,
                                                'bank', tx.payer_name, NULL);
                    PERFORM learn_payer_name(cand.m_contract_id, tx.payer_name);
                    v_left := v_left - v_apply;
                    v_nos := v_nos || cand.m_invoice_no;
                END LOOP;

                IF array_length(v_nos, 1) IS NULL THEN
                    v_nos := '{}';
                ELSE
                    v_by := CASE WHEN array_length(v_nos, 1) = 1 THEN 'name(oldest)'
                                 ELSE 'name(split/' || array_length(v_nos, 1) || ')' END;
                    v_inv := v_nos[1];
                END IF;

                IF v_left > 0 AND v_inv IS NOT NULL THEN
                    -- どの請求にも押し込まない。押し込むとその請求が過入金になる。
                    v_note := '　※ ¥' || trim(to_char(v_left, 'FM999,999,999'))
                              || ' は充当先の請求が無く前受けです';
                    v_over := v_over + 1;
                END IF;
            END IF;
        ELSE
            -- 名義で絞れない (該当なし / 複数社)。残額一致が1件だけなら消し込む。
            SELECT count(*), min(i.invoice_no) INTO v_cnt, v_inv
              FROM invoices i
             WHERE i.status IN ('issued', 'sent', 'partial')
               AND (i.total - i.paid_amount) = tx.amount;
            IF v_cnt = 1 THEN
                v_by := 'amount';
                SELECT contract_id INTO v_cid FROM invoices WHERE invoice_no = v_inv;
                PERFORM add_invoice_payment(v_inv, tx.paid_on, tx.amount, 'bank', tx.payer_name, NULL);
                PERFORM learn_payer_name(v_cid, tx.payer_name);
                v_nos := ARRAY[v_inv];
            ELSE
                v_inv := NULL;
            END IF;
        END IF;

        IF v_inv IS NOT NULL THEN
            UPDATE bank_transactions
               SET match_status = 'matched', matched_invoice_no = array_to_string(v_nos, ', '),
                   match_note = v_by || v_note, matched_at = now()
             WHERE id = tx.id;
            v_matched := v_matched + 1;
            v_list := v_list || jsonb_build_object(
                'invoice_no', array_to_string(v_nos, ', '), 'amount', tx.amount,
                'payer_name', tx.payer_name, 'paid_on', tx.paid_on,
                'matched_by', v_by, 'unapplied', v_left);
        ELSIF v_cnt > 1 OR v_cust > 1 THEN
            UPDATE bank_transactions
               SET match_status = 'ambiguous',
                   match_note = CASE
                     WHEN v_cust > 1 THEN '名義が複数の顧客に一致し、金額でも特定できません'
                     ELSE '同額の未入金が ' || v_cnt || ' 件あり、名義でも特定できません' END
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
        'over_paid', v_over,
        'matched_list', v_list, 'ambiguous_list', v_amb);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp;


-- =========================================================
-- 3. 取込の指紋
--
-- 95 は ref の無い明細に「同じ内容が既に何件あるか」で連番を振っていたが、
-- これは取込のたびに増えるため、同じCSVを2回貼ると別の指紋になり、
-- 二重取込を防ぐという指紋の目的そのものを打ち消していた。
-- 連番は「今回の取込の中で何本目か」を呼び出し側 (GAS) が振る。
-- =========================================================
CREATE OR REPLACE FUNCTION import_bank_transaction(
    p_paid_on DATE,
    p_amount NUMERIC,
    p_payer_name TEXT DEFAULT '',
    p_memo TEXT DEFAULT '',
    p_source TEXT DEFAULT 'csv',
    p_ref TEXT DEFAULT ''
) RETURNS JSONB AS $$
DECLARE
    v_fp   TEXT;
    v_id   UUID;
    v_ref  TEXT := COALESCE(NULLIF(trim(p_ref), ''), '');
BEGIN
    IF p_paid_on IS NULL OR COALESCE(p_amount, 0) <= 0 THEN
        RETURN jsonb_build_object('success', false, 'message', '日付と金額が必要です');
    END IF;

    v_fp := md5(p_paid_on::TEXT || '|' || p_amount::TEXT || '|'
                || COALESCE(norm_payer(p_payer_name), '') || '|' || COALESCE(p_memo, '')
                || '|' || v_ref);

    INSERT INTO bank_transactions (paid_on, amount, payer_name, memo, source, fingerprint, ref)
    VALUES (p_paid_on, p_amount, COALESCE(p_payer_name, ''), COALESCE(p_memo, ''),
            COALESCE(NULLIF(p_source, ''), 'csv'), v_fp, v_ref)
    ON CONFLICT (fingerprint) DO NOTHING
    RETURNING id INTO v_id;

    IF v_id IS NULL THEN
        RETURN jsonb_build_object('success', true, 'duplicated', true);
    END IF;
    RETURN jsonb_build_object('success', true, 'id', v_id, 'ref', v_ref);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp;


-- =========================================================
-- 4. 権限
-- =========================================================
REVOKE EXECUTE ON FUNCTION payer_matched_invoices(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION auto_match_payments(INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION import_bank_transaction(DATE, NUMERIC, TEXT, TEXT, TEXT, TEXT)
                                                   FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION payer_matched_invoices(TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION auto_match_payments(INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION import_bank_transaction(DATE, NUMERIC, TEXT, TEXT, TEXT, TEXT) TO service_role;

NOTIFY pgrst, 'reload schema';
