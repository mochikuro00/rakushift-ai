-- =========================================================
-- 76_data_retention_policy.sql
-- 目的: 長期運用でのDB容量肥大を防ぐ保持ポリシー。
--       「2年より古いシフト」「2年より古い申請」を毎日深夜に自動削除する。
--
-- 背景: シフトは1件約311バイト(インデックス込)で増え続ける唯一の業務データ。
--       分析レポート等の参照は直近データが中心のため、2年で十分な保持期間。
--       これにより店舗数が増えてもDB容量は「直近2年分」で頭打ちになる。
--
-- 既存の掃除ジョブ (3:10 sessions / 3:20 error logs / 3:30 login attempts)
-- と同じ pg_cron 方式。pg_cron が無い環境では登録をスキップ (エラーにしない)。
-- =========================================================

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
        RAISE NOTICE 'pg_cron not installed - skipping retention job setup.';
        RETURN;
    END IF;

    -- 再実行安全: 既存の同名ジョブは一度解除してから登録
    PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'retention-old-shifts';
    PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'retention-old-requests';

    PERFORM cron.schedule(
        'retention-old-shifts',
        '40 3 * * *',
        $job$DELETE FROM shifts WHERE date < CURRENT_DATE - interval '2 years'$job$
    );

    PERFORM cron.schedule(
        'retention-old-requests',
        '50 3 * * *',
        $job$DELETE FROM requests WHERE created_at < now() - interval '2 years'$job$
    );

    RAISE NOTICE 'Retention jobs registered (shifts/requests older than 2 years, daily 3:40/3:50).';
END $$;
