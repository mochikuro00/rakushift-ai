-- =========================================================
-- 78_manual_cancel_request.sql
-- 目的: 手動発行ライセンステナントのセルフ解約申請を記録する。
--       発効日ルールは「申請した月の末日 (当月末)」。
--       Stripe 契約テナントはポータルで完結するため対象外。
-- =========================================================

ALTER TABLE config
    ADD COLUMN IF NOT EXISTS cancel_requested_at TIMESTAMP WITH TIME ZONE,
    ADD COLUMN IF NOT EXISTS cancel_effective_date DATE;

COMMENT ON COLUMN config.cancel_requested_at IS '手動テナントの解約申請日時 (NULL=申請なし)';
COMMENT ON COLUMN config.cancel_effective_date IS '解約発効日 (申請月の末日)';

NOTIFY pgrst, 'reload schema';
