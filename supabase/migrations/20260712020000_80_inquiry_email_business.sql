-- =========================================================
-- 80_inquiry_email_business.sql
-- 目的: お問い合わせ(3店舗以上申込)フォームに「事業者名」「メールアドレス」を追加。
--       顧客情報の統合ビューに反映するための列。
-- =========================================================

ALTER TABLE inquiries
    ADD COLUMN IF NOT EXISTS email TEXT,
    ADD COLUMN IF NOT EXISTS business_name TEXT;

COMMENT ON COLUMN inquiries.email IS '申込者のメールアドレス';
COMMENT ON COLUMN inquiries.business_name IS '事業者名 (会社名とは別)';

NOTIFY pgrst, 'reload schema';
