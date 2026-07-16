-- =========================================================
-- 83_inquiry_referrer_code.sql
-- 目的: 3店舗以上お問い合わせフォームに紹介者コード欄を追加。
-- =========================================================

ALTER TABLE inquiries
    ADD COLUMN IF NOT EXISTS referrer_code TEXT;

COMMENT ON COLUMN inquiries.referrer_code IS 'お問い合わせ時の紹介者コード';

NOTIFY pgrst, 'reload schema';
