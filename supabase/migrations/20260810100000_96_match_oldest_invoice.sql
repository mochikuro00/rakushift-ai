-- =========================================================
-- 96_match_oldest_invoice.sql   (v3.7.287)
--
-- 同じ顧客の未入金が複数あるときに自動消込できない問題の解消。
--
-- これまでは「候補が1件でなければ要確認」だったため、
--   同じ顧客が 8月分と9月分を別々に振り込む
--   (どちらも同額なので候補が2件になる)
-- という普通の運用で、毎回2件とも人手に回っていた。
--
-- 名義で顧客が1社に定まっているなら、どの請求に充てるかは
-- 「古い方から」で運用上まず問題にならない (誤請求にならない)。
-- 顧客が複数社に散る場合だけ要確認に残す。
-- =========================================================

CREATE OR REPLACE FUNCTION auto_match_payments(p_days INTEGER DEFAULT 90)
RETURNS JSONB AS $$
DECLARE
    tx        RECORD;
    v_cust    INTEGER;   -- 候補が何社にまたがるか
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
        v_cnt := 0;
        v_cust := 0;

        -- ---------------------------------------------------------
        -- ① 名義が一致する請求 (残額一致を優先)
        -- ---------------------------------------------------------
        WITH named AS (
            SELECT i.invoice_no, i.contract_id, i.period_start, i.issue_date,
                   (i.total - i.paid_amount) AS balance
              FROM invoices i
              LEFT JOIN config c ON c.contract_id = i.contract_id
             WHERE i.status IN ('issued', 'sent', 'partial')
               AND norm_payer(tx.payer_name) IS NOT NULL
               AND (
                     norm_payer(tx.payer_name) = norm_payer(i.payer_name)
                  OR norm_payer(tx.payer_name) = norm_payer(i.company_name)
                  OR norm_payer(tx.payer_name) = norm_payer(i.shop_name)
                  OR EXISTS (SELECT 1 FROM unnest(COALESCE(c.payer_names, '{}')) AS pn
                              WHERE norm_payer(pn) = norm_payer(tx.payer_name))
                  OR EXISTS (SELECT 1 FROM invoices p
                              WHERE p.contract_id = i.contract_id
                                AND p.status = 'paid' AND p.payer_name <> ''
                                AND norm_payer(p.payer_name) = norm_payer(tx.payer_name))
                   )
        )
        SELECT count(DISTINCT contract_id), count(*) INTO v_cust, v_cnt FROM named;

        IF v_cust = 1 THEN
            -- 顧客が1社に定まった。残額が一致する請求があればそれ、無ければ最も古い請求。
            SELECT invoice_no INTO v_inv FROM (
                SELECT i.invoice_no, (i.total - i.paid_amount) AS balance,
                       i.period_start, i.issue_date
                  FROM invoices i
                  LEFT JOIN config c ON c.contract_id = i.contract_id
                 WHERE i.status IN ('issued', 'sent', 'partial')
                   AND norm_payer(tx.payer_name) IS NOT NULL
                   AND (
                         norm_payer(tx.payer_name) = norm_payer(i.payer_name)
                      OR norm_payer(tx.payer_name) = norm_payer(i.company_name)
                      OR norm_payer(tx.payer_name) = norm_payer(i.shop_name)
                      OR EXISTS (SELECT 1 FROM unnest(COALESCE(c.payer_names, '{}')) AS pn
                                  WHERE norm_payer(pn) = norm_payer(tx.payer_name))
                      OR EXISTS (SELECT 1 FROM invoices p
                                  WHERE p.contract_id = i.contract_id
                                    AND p.status = 'paid' AND p.payer_name <> ''
                                    AND norm_payer(p.payer_name) = norm_payer(tx.payer_name))
                       )
            ) s
            ORDER BY (s.balance = tx.amount) DESC,   -- 残額一致を最優先
                     s.period_start NULLS LAST, s.issue_date
            LIMIT 1;
            v_by := CASE WHEN v_cnt = 1 THEN 'amount+name' ELSE 'name(oldest)' END;
        ELSIF v_cust > 1 THEN
            -- 名義が複数社に当たってしまう。金額で絞れるか試す。
            SELECT count(*), min(i.invoice_no) INTO v_cnt, v_inv
              FROM invoices i
             WHERE i.status IN ('issued', 'sent', 'partial')
               AND (i.total - i.paid_amount) = tx.amount;
            IF v_cnt = 1 THEN
                v_by := 'amount';
            ELSE
                v_inv := NULL;
            END IF;
        ELSE
            -- 名義では当たらない。残額一致が1件だけなら消し込む。
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
            PERFORM add_invoice_payment(v_inv, tx.paid_on, tx.amount, 'bank', tx.payer_name, NULL);
            PERFORM learn_payer_name(v_cid, tx.payer_name);
            UPDATE bank_transactions
               SET match_status = 'matched', matched_invoice_no = v_inv,
                   match_note = v_by, matched_at = now()
             WHERE id = tx.id;
            v_matched := v_matched + 1;
            v_list := v_list || jsonb_build_object('invoice_no', v_inv, 'amount', tx.amount,
                                                   'payer_name', tx.payer_name,
                                                   'paid_on', tx.paid_on, 'matched_by', v_by);
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
        'matched_list', v_list, 'ambiguous_list', v_amb);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp;

REVOKE EXECUTE ON FUNCTION auto_match_payments(INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION auto_match_payments(INTEGER) TO service_role;

NOTIFY pgrst, 'reload schema';
