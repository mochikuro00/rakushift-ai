-- =========================================================
-- 95_bank_tx_fingerprint.sql   (v3.7.287)
--
-- 同日・同額・同名義の入金が1件に潰される不具合の修正。
--
-- 指紋を「日付+金額+名義+摘要」で作っていたため、
-- 同じ顧客が同じ日に同額を2本振り込むと、2本目が重複として捨てられていた。
-- (2店舗分をまとめず別々に振り込む、といった運用で普通に起きる)
--
-- 銀行明細には取引を識別できる値 (残高・取引番号) があるので、
-- それを ref として指紋に含める。無い場合は取込時の連番で区別する。
-- =========================================================

ALTER TABLE bank_transactions
    ADD COLUMN IF NOT EXISTS ref TEXT NOT NULL DEFAULT '';

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
    v_same INTEGER;
BEGIN
    IF p_paid_on IS NULL OR COALESCE(p_amount, 0) <= 0 THEN
        RETURN jsonb_build_object('success', false, 'message', '日付と金額が必要です');
    END IF;

    -- ref が無い明細は、同じ内容が既に何件あるかを数えて連番を付ける。
    -- これで「同日・同額・同名義の2本目」を別の取引として扱える。
    IF v_ref = '' THEN
        SELECT count(*) INTO v_same
          FROM bank_transactions
         WHERE paid_on = p_paid_on
           AND amount = p_amount
           AND COALESCE(norm_payer(payer_name), '') = COALESCE(norm_payer(p_payer_name), '')
           AND COALESCE(memo, '') = COALESCE(p_memo, '');
        v_ref := '#' || (v_same + 1)::TEXT;
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

DROP FUNCTION IF EXISTS import_bank_transaction(DATE, NUMERIC, TEXT, TEXT, TEXT);

REVOKE EXECUTE ON FUNCTION import_bank_transaction(DATE, NUMERIC, TEXT, TEXT, TEXT, TEXT)
                                                   FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION import_bank_transaction(DATE, NUMERIC, TEXT, TEXT, TEXT, TEXT) TO service_role;

NOTIFY pgrst, 'reload schema';
