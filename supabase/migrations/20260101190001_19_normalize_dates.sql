-- 19_normalize_dates.sql
-- ===========================================================
-- Migration: カンマ区切り文字列のデータを配列(TEXT[])に正規化
-- ===========================================================

-- 1. staff テーブルの unavailable_dates を TEXT[] に変換
-- string_to_array を用いて、既存のカンマ区切りデータを配列に変換する。
ALTER TABLE staff
ALTER COLUMN unavailable_dates TYPE TEXT[]
USING string_to_array(replace(COALESCE(unavailable_dates, ''), ' ', ''), ',')::TEXT[];

-- 空文字列の配列になっている要素 [''] を空配列 [] に正規化
UPDATE staff
SET unavailable_dates = '{}'::TEXT[]
WHERE unavailable_dates = ARRAY['']::TEXT[];

-- ※ requests テーブルの dates カラムは、現状1行につき1日付として保存される
-- 仕様となっているため、TEXT型のまま維持します。
