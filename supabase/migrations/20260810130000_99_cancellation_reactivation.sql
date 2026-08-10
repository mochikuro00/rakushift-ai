-- =========================================================
-- 99_cancellation_reactivation.sql   (v3.7.287)
--
-- 復帰した顧客が解約者台帳に残り続ける問題の修正。
--
-- sync_cancellations は未払いによるライセンス停止 (license_status='suspended')
-- も解約として記録する。停止は支払いがあれば解除されるが、台帳から取り消す
-- 経路が無かったため、払って継続している顧客が解約者として残っていた。
-- 解約率・早期解約率の集計がそのぶん狂う。
--
-- 同期のたびに「稼働中に戻った顧客」を台帳から外す。
-- ただし外すのは同期が自動で入れた行 (reason が空) だけにする。
-- 運営やWebhookが理由を書いて記録した行は、人の判断なので消さない。
-- テナントが config から消えている行も残す (テナント削除後も追えることが
-- この台帳の存在意義)。
-- =========================================================

CREATE OR REPLACE FUNCTION sync_cancellations()
RETURNS JSONB AS $$
DECLARE
    rec RECORD;
    n INTEGER := 0;
    skipped INTEGER := 0;
    revived INTEGER := 0;
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

    -- 稼働中に戻った顧客を台帳から外す
    WITH gone AS (
        DELETE FROM cancellations x
         USING v_customer_ledger v
         WHERE v.contract_id = x.contract_id
           AND x.reason = ''                      -- 同期が自動で入れた行だけ
           AND v.license_status = 'active'
           AND COALESCE(v.subscription_status, '') <> 'canceled'
           AND v.cancel_requested_at IS NULL
           AND (v.cancel_effective_date IS NULL
                OR v.cancel_effective_date > (now() AT TIME ZONE 'Asia/Tokyo')::DATE)
        RETURNING x.id
    )
    SELECT count(*) INTO revived FROM gone;

    RETURN jsonb_build_object('success', true, 'synced', n,
                              'skipped_no_date', skipped, 'reactivated', revived);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp;

REVOKE EXECUTE ON FUNCTION sync_cancellations() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION sync_cancellations() TO service_role;

NOTIFY pgrst, 'reload schema';
