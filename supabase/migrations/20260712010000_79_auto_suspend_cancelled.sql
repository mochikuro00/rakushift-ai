-- =========================================================
-- 79_auto_suspend_cancelled.sql
-- 目的: 手動発行テナントの解約申請 (migration 78) を発効日に自動執行する。
--       発効日 (申請月の末日) いっぱいは利用可能とし、翌日 0:05 JST に停止。
--
-- 動作: 毎日 15:05 UTC (= 0:05 JST) に、発効日を過ぎた申請済みテナントを
--       suspend_license と同じ状態に更新する (停止・6ヶ月後データ削除予定)。
--       Stripe 契約テナントは対象外 (Webhook 経由で自動同期)。
-- =========================================================

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
        RAISE NOTICE 'pg_cron not installed - skipping auto-suspend job setup.';
        RETURN;
    END IF;

    PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'auto-suspend-cancelled';

    PERFORM cron.schedule(
        'auto-suspend-cancelled',
        '5 15 * * *',  -- 15:05 UTC = 翌日 0:05 JST
        $job$
        UPDATE organizations o SET
            license_status = 'suspended',
            license_suspended_at = now(),
            data_deletion_scheduled_at = now() + INTERVAL '6 months',
            license_note = COALESCE(NULLIF(o.license_note, ''), 'セルフ解約申請による自動停止 (発効日: ' ||
                (SELECT c2.cancel_effective_date::text FROM config c2 WHERE c2.organization_id = o.id LIMIT 1) || ')')
        FROM config c
        WHERE c.organization_id = o.id
          AND c.cancel_requested_at IS NOT NULL
          AND c.cancel_effective_date IS NOT NULL
          AND c.cancel_effective_date < (now() AT TIME ZONE 'Asia/Tokyo')::date
          AND c.stripe_subscription_id IS NULL
          AND COALESCE(o.license_status, 'active') <> 'suspended'
        $job$
    );

    RAISE NOTICE 'auto-suspend-cancelled job registered (daily 0:05 JST).';
END $$;
