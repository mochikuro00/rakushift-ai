-- =========================================================
-- 100_null_role_bypass_retry.sql   (v3.7.288)
--
-- 72 が一度も実行できておらず、認証バイパスが残っていた問題の修正。
--
-- ■ 何が起きていたか
--   運営専用の関数は、こう書かれている:
--     SELECT role INTO v_role FROM auth_sessions WHERE id = get_session_id() ...;
--     IF v_role NOT IN ('hq_admin', 'platform_admin') THEN
--         RAISE EXCEPTION 'Access denied';
--     END IF;
--   セッションが見つからないと v_role は NULL になり、
--   NULL NOT IN (...) は NULL (真ではない) なので分岐に入らない。
--   つまり「セッションが無い」ほどチェックを素通りする。
--   対象の関数はすべて anon に EXECUTE が付いており、公開されている
--   anon キーから直接呼べる状態だった。
--
-- ■ なぜ 72 で直っていなかったか
--   72 は public の関数を pg_get_functiondef で舐めて書き換える作りだが、
--   WHERE 句の中で pg_get_functiondef(p.oid) を呼んでいた。
--   プランナが nspname='public' の絞り込みより先にこれを評価すると
--   pg_catalog の集約関数に当たり
--     ERROR: "array_agg" is an aggregate function
--   で DO ブロックごと中断する。中断すれば1件も書き換わらないが、
--   失敗しても気付ける仕組みが無かった。
--
-- ■ 対策
--   1. 絞り込みを MATERIALIZED CTE で確定させ、定義の取得を
--      「public の plpgsql/sql 関数」だけに限定する
--   2. 書き換え後に検証し、残っていれば例外にする。
--      黙って何もしないより、流れないほうがよい。
-- =========================================================

DO $$
DECLARE
    r         RECORD;
    new_def   TEXT;
    n         INTEGER := 0;
    remaining TEXT[];
BEGIN
    FOR r IN
        WITH pub AS MATERIALIZED (
            SELECT p.oid
              FROM pg_proc p
              JOIN pg_namespace ns ON ns.oid = p.pronamespace
              JOIN pg_language  l  ON l.oid  = p.prolang
             WHERE ns.nspname = 'public'
               AND p.prokind = 'f'                      -- 集約・ウィンドウ関数を除く
               AND l.lanname IN ('plpgsql', 'sql')
        )
        SELECT oid, pg_get_functiondef(oid) AS def FROM pub
    LOOP
        CONTINUE WHEN r.def !~ 'v_role\s+NOT\s+IN\s*\(';
        -- ロール名の並びは関数ごとに違うため、比較対象ではなく左辺だけを包む
        new_def := regexp_replace(r.def, 'v_role\s+NOT\s+IN\s*\(',
                                  'COALESCE(v_role, '''') NOT IN (', 'g');
        EXECUTE new_def;
        n := n + 1;
    END LOOP;

    RAISE NOTICE '[100] null-role バイパスを修正した関数数: %', n;

    SELECT array_agg(proname ORDER BY proname) INTO remaining
      FROM (
        WITH pub AS MATERIALIZED (
            SELECT p.oid, p.proname
              FROM pg_proc p
              JOIN pg_namespace ns ON ns.oid = p.pronamespace
              JOIN pg_language  l  ON l.oid  = p.prolang
             WHERE ns.nspname = 'public'
               AND p.prokind = 'f'
               AND l.lanname IN ('plpgsql', 'sql')
        )
        SELECT proname, pg_get_functiondef(oid) AS def FROM pub
      ) x
     WHERE x.def ~ 'v_role\s+NOT\s+IN\s*\(';

    IF remaining IS NOT NULL THEN
        RAISE EXCEPTION '[100] null-role バイパスが残っています: %',
                        array_to_string(remaining, ', ');
    END IF;
END $$;

NOTIFY pgrst, 'reload schema';
