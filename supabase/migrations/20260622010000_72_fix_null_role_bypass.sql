-- 72_fix_null_role_bypass.sql
-- ===========================================================
-- 緊急セキュリティ修正 (P1): 本部/運営管理 RPC の NULL-role バイパス
--
-- 問題:
--   多数の SECURITY DEFINER 関数が以下のガードを持つ:
--     SELECT role INTO v_role FROM auth_sessions WHERE id = get_session_id() ...;
--     IF v_role NOT IN ('hq_admin', 'platform_admin') THEN RAISE EXCEPTION ...
--   セッションが無い/期限切れだと v_role は NULL。PostgreSQL では
--   `NULL NOT IN (...)` は NULL (= TRUE ではない) と評価されるため RAISE されず、
--   無認証の第三者が list_tenants / delete_tenant_data / create_hq_admin 等を
--   実行できてしまう (これらは anon に GRANT 済み)。
--
-- 修正:
--   現行の関数定義を pg_get_functiondef で取得し、ガード行を
--     COALESCE(v_role, '') NOT IN ('hq_admin', 'platform_admin')
--   に自動置換して再定義する。本体は一切変えずガードだけを null安全化する。
--   (手書き再現による転記ミスを避け、対象関数を取りこぼさない。冪等)
-- ===========================================================

DO $$
DECLARE
    r RECORD;
    new_def TEXT;
    n INTEGER := 0;
BEGIN
    FOR r IN
        SELECT p.oid, pg_get_functiondef(p.oid) AS def
        FROM pg_proc p
        JOIN pg_namespace ns ON ns.oid = p.pronamespace
        WHERE ns.nspname = 'public'
          AND pg_get_functiondef(p.oid) ~ 'v_role\s+NOT\s+IN\s*\(\s*''hq_admin''\s*,\s*''platform_admin''\s*\)'
    LOOP
        new_def := regexp_replace(
            r.def,
            'v_role\s+NOT\s+IN\s*\(\s*''hq_admin''\s*,\s*''platform_admin''\s*\)',
            'COALESCE(v_role, '''') NOT IN (''hq_admin'', ''platform_admin'')',
            'g'
        );
        EXECUTE new_def;
        n := n + 1;
    END LOOP;
    RAISE NOTICE '[72] null-role バイパスを修正した関数数: %', n;
END $$;

NOTIFY pgrst, 'reload schema';
