-- =========================================================
-- 77_delta_sync_and_archive.sql
-- 目的: 転送量・容量の最適化 (無料版/Pro の寿命を大幅に延ばす)
--   1. shifts.updated_at + 自動更新トリガー (差分同期の基盤)
--   2. delta_shifts_by_contract: 差分同期RPC
--      - p_since 指定時: 変更行のみ + 範囲内の全ID (削除検知用) を返す
--      - p_since NULL: 全行を返す (初回ロード)。列は画面に必要な7列のみに絞る
--        (organization_id 等を除外し転送を削減)
--   3. 集計アーカイブ: 2年超の生シフトを月次集計 (組織×月×スタッフ) に
--      圧縮保存してから削除。分析用の実績は何年分でも残り、容量は1/100。
--      migration 76 の retention-old-shifts ジョブを置き換える。
-- =========================================================

-- ---------- 1. updated_at + トリガー ----------
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

CREATE OR REPLACE FUNCTION _touch_updated_at() RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_shifts_updated_at ON shifts;
CREATE TRIGGER trg_shifts_updated_at
    BEFORE UPDATE ON shifts
    FOR EACH ROW EXECUTE FUNCTION _touch_updated_at();

-- 差分検索用 (組織×更新時刻)
CREATE INDEX IF NOT EXISTS idx_shifts_org_updated ON shifts(organization_id, updated_at);

-- ---------- 2. 差分同期 RPC ----------
DROP FUNCTION IF EXISTS delta_shifts_by_contract(TEXT, TEXT, TEXT, TIMESTAMPTZ);
CREATE OR REPLACE FUNCTION delta_shifts_by_contract(
    p_contract_id TEXT,
    p_from TEXT DEFAULT NULL,
    p_to TEXT DEFAULT NULL,
    p_since TIMESTAMPTZ DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
    v_org_id UUID;
    v_now TIMESTAMPTZ := now();
BEGIN
    SELECT organization_id INTO v_org_id FROM config WHERE contract_id = p_contract_id;
    IF v_org_id IS NULL THEN
        RETURN jsonb_build_object('server_time', v_now, 'ids', '[]'::jsonb, 'changed', '[]'::jsonb);
    END IF;
    RETURN jsonb_build_object(
        'server_time', v_now,
        -- 範囲内の全ID (クライアントはこれに無いローカル行を削除扱いにする)
        'ids', COALESCE((
            SELECT jsonb_agg(s.id)
            FROM shifts s
            WHERE s.organization_id = v_org_id
              AND (p_from IS NULL OR s.date >= p_from::DATE)
              AND (p_to IS NULL OR s.date <= p_to::DATE)
        ), '[]'::jsonb),
        -- 変更行のみ (p_since NULL なら全行)。列は画面必須の7列に絞る
        'changed', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'id', s.id,
                'staff_id', s.staff_id,
                'date', s.date,
                'start_time', s.start_time,
                'end_time', s.end_time,
                'break_minutes', s.break_minutes,
                'is_irregular', s.is_irregular,
                'memo', s.memo
            ) ORDER BY s.date, s.start_time)
            FROM shifts s
            WHERE s.organization_id = v_org_id
              AND (p_from IS NULL OR s.date >= p_from::DATE)
              AND (p_to IS NULL OR s.date <= p_to::DATE)
              AND (p_since IS NULL OR s.updated_at > p_since)
        ), '[]'::jsonb)
    );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, extensions, pg_temp;
GRANT EXECUTE ON FUNCTION delta_shifts_by_contract(TEXT, TEXT, TEXT, TIMESTAMPTZ) TO anon;

-- ---------- 3. 集計アーカイブ ----------
CREATE TABLE IF NOT EXISTS shift_archive_monthly (
    organization_id UUID NOT NULL,
    ym TEXT NOT NULL,                 -- 'YYYY-MM'
    staff_id UUID NOT NULL,
    work_days INTEGER NOT NULL DEFAULT 0,
    work_minutes INTEGER NOT NULL DEFAULT 0,   -- 実労働 (休憩控除後)
    break_minutes INTEGER NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (organization_id, ym, staff_id)
);
ALTER TABLE shift_archive_monthly ENABLE ROW LEVEL SECURITY;  -- anon 直アクセス不可

CREATE OR REPLACE FUNCTION archive_and_purge_old_shifts() RETURNS void AS $$
DECLARE
    v_cutoff DATE := (CURRENT_DATE - INTERVAL '2 years')::DATE;
BEGIN
    INSERT INTO shift_archive_monthly (organization_id, ym, staff_id, work_days, work_minutes, break_minutes)
    SELECT s.organization_id,
           to_char(s.date, 'YYYY-MM'),
           s.staff_id,
           COUNT(DISTINCT s.date)::INTEGER,
           SUM(GREATEST(0,
               (EXTRACT(EPOCH FROM (s.end_time - s.start_time)) / 60)::INTEGER
               + CASE WHEN s.end_time <= s.start_time THEN 1440 ELSE 0 END
               - COALESCE(s.break_minutes, 0)
           ))::INTEGER,
           SUM(COALESCE(s.break_minutes, 0))::INTEGER
    FROM shifts s
    WHERE s.date < v_cutoff
      AND s.organization_id IS NOT NULL
      AND s.staff_id IS NOT NULL
    GROUP BY s.organization_id, to_char(s.date, 'YYYY-MM'), s.staff_id
    ON CONFLICT (organization_id, ym, staff_id) DO UPDATE SET
        work_days = shift_archive_monthly.work_days + EXCLUDED.work_days,
        work_minutes = shift_archive_monthly.work_minutes + EXCLUDED.work_minutes,
        break_minutes = shift_archive_monthly.break_minutes + EXCLUDED.break_minutes,
        updated_at = now();

    DELETE FROM shifts WHERE date < v_cutoff;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, extensions, pg_temp;

-- retention-old-shifts (migration 76 の単純削除) をアーカイブ付きに置き換え
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
        RAISE NOTICE 'pg_cron not installed - skipping job replacement.';
        RETURN;
    END IF;
    PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'retention-old-shifts';
    PERFORM cron.schedule(
        'retention-old-shifts',
        '40 3 * * *',
        $job$SELECT archive_and_purge_old_shifts()$job$
    );
END $$;

NOTIFY pgrst, 'reload schema';
