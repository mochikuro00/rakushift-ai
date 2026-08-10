-- =========================================================
-- 94_add_payment_not_overwrite.sql   (v3.7.287)
--
-- 分割入金が合算されない不具合の修正。
--
-- record_invoice_payment は paid_amount を「置き換え」る。
-- 運営が画面で入力する場合は「入金額の訂正」なので置き換えが正しいが、
-- 銀行明細からの自動消込は「入金が1本届いた」なので加算でなければならない。
--
--   例) 請求 3,380円
--       1本目 1,000円 → paid_amount = 1,000 (partial)
--       2本目 2,380円 → 置き換えると paid_amount = 2,380 のまま partial
--                       実際は完済なのに未入金として督促が飛ぶ
--
-- 加算用の関数を分け、自動消込側だけ加算にする。
-- =========================================================

CREATE OR REPLACE FUNCTION add_invoice_payment(
    p_invoice_no     TEXT,
    p_paid_at        DATE,
    p_amount         NUMERIC,
    p_payment_method TEXT DEFAULT 'bank',
    p_payer_name     TEXT DEFAULT '',
    p_note           TEXT DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
    v_row invoices%ROWTYPE;
BEGIN
    IF COALESCE(p_amount, 0) <= 0 THEN
        RETURN jsonb_build_object('success', false, 'invoice_no', p_invoice_no,
                                  'message', '入金額が不正です');
    END IF;

    UPDATE invoices
       SET paid_amount    = paid_amount + p_amount,   -- 置き換えではなく加算
           paid_at        = p_paid_at,
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
        'balance', v_row.total - v_row.paid_amount);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp;


-- =========================================================
-- 自動消込は加算に切り替える
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

        -- ① 残額一致 かつ 名義一致
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
              OR EXISTS (SELECT 1 FROM unnest(COALESCE(c.payer_names, '{}')) AS pn
                          WHERE norm_payer(pn) = norm_payer(tx.payer_name))
              OR EXISTS (SELECT 1 FROM invoices p
                          WHERE p.contract_id = i.contract_id
                            AND p.status = 'paid' AND p.payer_name <> ''
                            AND norm_payer(p.payer_name) = norm_payer(tx.payer_name))
               );
        IF v_cnt = 1 THEN
            v_by := 'amount+name';
        ELSE
            v_inv := NULL;
            SELECT count(*), min(i.invoice_no) INTO v_cnt, v_inv
              FROM invoices i
             WHERE i.status IN ('issued', 'sent', 'partial')
               AND (i.total - i.paid_amount) = tx.amount;
            IF v_cnt = 1 THEN
                v_by := 'amount';
            ELSE
                v_inv := NULL;
                -- ③ 金額が残額と一致しない (一部入金・前払い) 場合でも、
                --    名義で顧客が一意に決まり、その顧客の未入金請求が1件だけなら充当する。
                --    分割で振り込まれるケースを自動で拾うため。
                SELECT count(*), min(i.invoice_no) INTO v_cnt, v_inv
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
                       );
                IF v_cnt = 1 THEN
                    v_by := 'name(partial)';
                ELSE
                    v_inv := NULL;
                END IF;
            END IF;
        END IF;

        IF v_inv IS NOT NULL THEN
            SELECT contract_id INTO v_cid FROM invoices WHERE invoice_no = v_inv;
            -- 銀行明細は「届いた入金1本」なので加算する。置き換えると分割入金が消える。
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


-- 手動での紐付けも加算にする (同じく「届いた入金1本」のため)
CREATE OR REPLACE FUNCTION assign_bank_transaction(p_tx_id UUID, p_invoice_no TEXT)
RETURNS JSONB AS $$
DECLARE tx RECORD; res JSONB; v_cid TEXT;
BEGIN
    SELECT * INTO tx FROM bank_transactions WHERE id = p_tx_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'message', '入金明細が見つかりません');
    END IF;
    IF tx.match_status = 'matched' THEN
        RETURN jsonb_build_object('success', false, 'message', 'この明細は既に消込済みです');
    END IF;
    res := add_invoice_payment(p_invoice_no, tx.paid_on, tx.amount, 'bank', tx.payer_name, NULL);
    IF (res->>'success')::BOOLEAN IS NOT TRUE THEN
        RETURN res;
    END IF;
    SELECT contract_id INTO v_cid FROM invoices WHERE invoice_no = p_invoice_no;
    PERFORM learn_payer_name(v_cid, tx.payer_name);
    UPDATE bank_transactions
       SET match_status = 'matched', matched_invoice_no = p_invoice_no,
           match_note = 'manual', matched_at = now()
     WHERE id = p_tx_id;
    RETURN jsonb_build_object('success', true, 'invoice_no', p_invoice_no,
                              'paid_amount', res->'paid_amount', 'balance', res->'balance');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp;


REVOKE EXECUTE ON FUNCTION add_invoice_payment(TEXT, DATE, NUMERIC, TEXT, TEXT, TEXT)
                                                       FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION auto_match_payments(INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION assign_bank_transaction(UUID, TEXT) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION add_invoice_payment(TEXT, DATE, NUMERIC, TEXT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION auto_match_payments(INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION assign_bank_transaction(UUID, TEXT) TO service_role;

NOTIFY pgrst, 'reload schema';
