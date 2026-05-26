-- 46_resolve_config_id_by_contract.sql
-- ===========================================================
-- セッション失効後でも contract_id から config.id を解決できる
-- セッションレス RPC を追加。
--
-- 背景:
--   Migration 43 で config_safe view を SECURITY INVOKER 化したため、
--   セッション (x-session-id ヘッダ) が auth_sessions に存在しない場合
--   config_safe が 0 行を返し、フロントの state.config.id が undefined
--   になる。結果として update_config_safe(p_config_id) を呼び出せず
--   ユーザが設定保存できなくなる。
--
-- 本 RPC は contract_id を入力として config.id を返す。
-- セキュリティ: contract_id は 15 桁ランダム数字 (10^15 通り) のため
-- 知らない第三者がブルートフォースで当てるのは現実的でない。
-- かつ、既存 update_config_safe(p_config_id) は SECURITY DEFINER で
-- config_id を知っていれば誰でも更新可能な設計のため、
-- 本 RPC を追加しても攻撃面は実質増えない (config_id を contract_id 経由で
-- 解決可能にするだけ)。
-- ===========================================================

CREATE OR REPLACE FUNCTION resolve_config_id_by_contract(p_contract_id TEXT)
RETURNS JSONB AS $$
DECLARE
    v_id UUID;
    v_org_id UUID;
BEGIN
    IF p_contract_id IS NULL OR p_contract_id = '' THEN
        RETURN jsonb_build_object('success', false, 'message', 'contract_id is required');
    END IF;

    SELECT id, organization_id INTO v_id, v_org_id
    FROM config
    WHERE contract_id = p_contract_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'message', 'contract not found');
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'config_id', v_id,
        'organization_id', v_org_id
    );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, pg_temp;

GRANT EXECUTE ON FUNCTION resolve_config_id_by_contract(TEXT) TO anon;

NOTIFY pgrst, 'reload schema';
