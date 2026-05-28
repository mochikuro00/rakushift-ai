-- 50_staff_attributes_columns.sql
-- ===========================================================
-- スタッフ属性 (希望時間帯・NG ペア・ポジション等) を専用カラムに昇格。
--
-- 背景:
--   旧仕様では、shift_priority と contract_type 以外のスタッフ属性
--   (pref_start_wd, ng_pairs, position 等) を unavailable_dates TEXT[]
--   にタグ形式で詰め込んでいた (例: "priority:high", "ngPair:山田")。
--   これによりシフト生成は機能していたが、SQL での絞り込みクエリ
--   (例: priority=high のスタッフだけ取得) ができない技術的負債が
--   蓄積していた。
--
-- 本マイグレーション:
--   1. staff テーブルに pref_*/ng_pairs/req_pairs/position/ng_weekdays
--      カラムを追加
--   2. 既存の unavailable_dates タグデータを新カラムへ移行
--   3. unavailable_dates から非日付タグを削除し、YYYY-MM-DD 形式の
--      実日付のみを残す
--   4. shift_priority と contract_type も unavailable_dates タグから
--      移行 (既存カラムは migration 21 で追加済みだが、フロントが
--      タグにしか書き込んでいなかったため、データが反映されていなかった)
-- ===========================================================

-- 1. 新カラム追加
ALTER TABLE public.staff
    ADD COLUMN IF NOT EXISTS pref_start_wd TEXT,
    ADD COLUMN IF NOT EXISTS pref_end_wd TEXT,
    ADD COLUMN IF NOT EXISTS pref_start_we TEXT,
    ADD COLUMN IF NOT EXISTS pref_end_we TEXT,
    ADD COLUMN IF NOT EXISTS ng_pairs TEXT,
    ADD COLUMN IF NOT EXISTS req_pairs TEXT,
    ADD COLUMN IF NOT EXISTS position TEXT DEFAULT 'any',
    ADD COLUMN IF NOT EXISTS ng_weekdays INTEGER[] DEFAULT '{}';

-- 2. 既存タグデータの移行
DO $$
DECLARE
    r RECORD;
    d TEXT;
    ngwd INTEGER[];
BEGIN
    FOR r IN SELECT id, unavailable_dates FROM staff WHERE unavailable_dates IS NOT NULL AND array_length(unavailable_dates, 1) > 0
    LOOP
        ngwd := ARRAY[]::INTEGER[];
        FOREACH d IN ARRAY r.unavailable_dates
        LOOP
            d := trim(d);
            CASE
                WHEN d LIKE 'priority:%' THEN
                    UPDATE staff SET shift_priority = substring(d FROM 10) WHERE id = r.id;
                WHEN d LIKE 'contract:%' THEN
                    UPDATE staff SET contract_type = substring(d FROM 10) WHERE id = r.id;
                WHEN d LIKE 'prefStartWd:%' THEN
                    UPDATE staff SET pref_start_wd = substring(d FROM 13) WHERE id = r.id;
                WHEN d LIKE 'prefEndWd:%' THEN
                    UPDATE staff SET pref_end_wd = substring(d FROM 11) WHERE id = r.id;
                WHEN d LIKE 'prefStartWe:%' THEN
                    UPDATE staff SET pref_start_we = substring(d FROM 13) WHERE id = r.id;
                WHEN d LIKE 'prefEndWe:%' THEN
                    UPDATE staff SET pref_end_we = substring(d FROM 11) WHERE id = r.id;
                WHEN d LIKE 'ngPair:%' THEN
                    UPDATE staff SET ng_pairs = substring(d FROM 8) WHERE id = r.id;
                WHEN d LIKE 'reqPair:%' THEN
                    UPDATE staff SET req_pairs = substring(d FROM 9) WHERE id = r.id;
                WHEN d LIKE 'position:%' THEN
                    UPDATE staff SET position = substring(d FROM 10) WHERE id = r.id;
                WHEN d LIKE 'ngDay:%' THEN
                    BEGIN
                        ngwd := array_append(ngwd, substring(d FROM 7)::INTEGER);
                    EXCEPTION WHEN OTHERS THEN
                        -- 不正な ngDay 値は無視
                        NULL;
                    END;
                ELSE
                    NULL;
            END CASE;
        END LOOP;
        IF array_length(ngwd, 1) > 0 THEN
            UPDATE staff SET ng_weekdays = ngwd WHERE id = r.id;
        END IF;
    END LOOP;
END $$;

-- 3. unavailable_dates から非日付タグを除去し、実日付 (YYYY-MM-DD) のみを残す
UPDATE staff
SET unavailable_dates = COALESCE(
    ARRAY(
        SELECT d
        FROM unnest(unavailable_dates) AS d
        WHERE trim(d) ~ '^\d{4}-\d{2}-\d{2}$'
    ),
    '{}'::TEXT[]
)
WHERE unavailable_dates IS NOT NULL;

-- 4. 絞り込みクエリ用インデックス
CREATE INDEX IF NOT EXISTS idx_staff_shift_priority
    ON public.staff(organization_id, shift_priority)
    WHERE shift_priority != 'medium';

CREATE INDEX IF NOT EXISTS idx_staff_position
    ON public.staff(organization_id, position)
    WHERE position != 'any';

-- PostgREST にスキーマ変更を通知
NOTIFY pgrst, 'reload schema';
