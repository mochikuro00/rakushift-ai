-- 19_normalize_dates.sql
-- ===========================================================
-- Migration: カンマ区切り文字列のデータを配列(TEXT[])に正規化
-- ===========================================================

-- 1. staff テーブルの unavailable_dates を TEXT[] に変換
-- string_to_array を用いて、既存のカンマ区切りデータを配列に変換する。
--
-- 01 で作られる staff_safe ビューがこの列を参照しているため、先にビューを
-- 落とさないと
--   ERROR: cannot alter type of a column used by a view or rule
-- で失敗する。失敗すると列は TEXT のまま残り、以降この列を配列として扱う
-- マイグレーション (50 / 52) が芋づるで落ちて、スタッフ属性の移行が
-- 丸ごと行われない。
-- 既に TEXT[] の環境では USING 式が成り立たないため、型を見てから変換する。
DO $$
BEGIN
    IF (SELECT format_type(atttypid, atttypmod)
          FROM pg_attribute
         WHERE attrelid = 'staff'::regclass
           AND attname = 'unavailable_dates') = 'text' THEN
        DROP VIEW IF EXISTS staff_safe;
        ALTER TABLE staff
        ALTER COLUMN unavailable_dates TYPE TEXT[]
        USING string_to_array(replace(COALESCE(unavailable_dates, ''), ' ', ''), ',')::TEXT[];
    END IF;
END $$;

-- 落とした場合に備えて作り直す (01 と同じ定義。後続の 43 で作り直される)
CREATE OR REPLACE VIEW staff_safe AS
SELECT
    id, organization_id, contract_id, name, login_id,
    -- password は絶対に公開しない
    role, evaluation, salary_type, hourly_wage, monthly_salary,
    annual_holidays, max_days_week, max_hours_day, unavailable_dates
FROM staff;
GRANT SELECT ON staff_safe TO anon;

-- 空文字列の配列になっている要素 [''] を空配列 [] に正規化
UPDATE staff
SET unavailable_dates = '{}'::TEXT[]
WHERE unavailable_dates = ARRAY['']::TEXT[];

-- ※ requests テーブルの dates カラムは、現状1行につき1日付として保存される
-- 仕様となっているため、TEXT型のまま維持します。
