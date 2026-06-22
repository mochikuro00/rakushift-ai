-- 71_lockdown_platform_secret_rpcs.sql
-- ===========================================================
-- 緊急セキュリティ修正 (P0): 機密を返す/書き換える RPC が anon(PUBLIC) から
-- 実行可能になっており、公開 anon キーだけで以下が漏洩していた:
--   - get_platform_settings(): supabase_service_key (DB全権限), stripe_secret_key,
--     stripe_webhook_secret, gemini_api_key, openai_api_key, smtp_pass 等を平文返却
--   - get_api_keys(contract_id): 各テナントの AI API キー
--   - update_platform_setting / _batch: 機密設定の上書き
--   - set_tenant_plan_manual: contract_id だけで任意テナントを有料プラン化
--
-- 対応: これらは「Railway バックエンド (service_role 鍵) からのみ」呼ばれる想定。
--       PUBLIC から EXECUTE を剥奪し、service_role にのみ付与する。
--       (service_role はバックエンドのサービスキーが持つロール。フロント anon は不可)
-- ===========================================================

REVOKE EXECUTE ON FUNCTION get_platform_settings()            FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION get_api_keys(TEXT)                 FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION update_platform_setting(TEXT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION update_platform_settings_batch(JSONB) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION set_tenant_plan_manual(TEXT, TEXT, TEXT) FROM PUBLIC;

-- バックエンド (service_role) からは引き続き呼べるようにする
GRANT EXECUTE ON FUNCTION get_platform_settings()            TO service_role;
GRANT EXECUTE ON FUNCTION get_api_keys(TEXT)                 TO service_role;
GRANT EXECUTE ON FUNCTION update_platform_setting(TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION update_platform_settings_batch(JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION set_tenant_plan_manual(TEXT, TEXT, TEXT) TO service_role;

-- update_config_safe は API キー列も書けるため anon からは剥奪 (アプリは
-- update_config_by_contract 経由で設定保存しており、こちらは別途存続)。
-- ※ シグネチャはプロジェクトの最新定義に合わせて調整してください。
-- REVOKE EXECUTE ON FUNCTION update_config_safe(UUID, JSONB) FROM PUBLIC;
-- GRANT  EXECUTE ON FUNCTION update_config_safe(UUID, JSONB) TO service_role;
