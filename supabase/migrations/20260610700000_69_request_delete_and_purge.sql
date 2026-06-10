-- 69_request_delete_and_purge.sql
-- ===========================================================
-- v3.7.152:
--   - delete_request_by_contract(contract_id, request_id)
--       承認/却下/承認待ち 問わず手動削除
--   - purge_old_requests_by_contract(contract_id, days)
--       N日 (デフォルト 90) より古い 承認済/却下 申請を一括削除
--       承認待ち (pending) は対象外で必ず残す
--
--   3ヶ月 = 90日 で運用する想定。クライアントは loadData 時に
--   purge_old_requests_by_contract(cid, 90) を呼んで自動掃除。
-- ===========================================================

CREATE OR REPLACE FUNCTION delete_request_by_contract(
    p_contract_id TEXT,
    p_request_id UUID
) RETURNS JSONB AS $$
DECLARE
    v_org_id UUID;
    v_deleted INTEGER;
BEGIN
    IF p_contract_id IS NULL OR p_contract_id = '' OR p_request_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'message', 'パラメータ不足');
    END IF;
    SELECT organization_id INTO v_org_id FROM config WHERE contract_id = p_contract_id;
    IF v_org_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'message', '契約が見つかりません');
    END IF;

    WITH d AS (
        DELETE FROM requests
        WHERE id = p_request_id AND organization_id = v_org_id
        RETURNING 1
    )
    SELECT count(*) INTO v_deleted FROM d;

    IF v_deleted = 0 THEN
        RETURN jsonb_build_object('success', false, 'message', '申請が見つかりません');
    END IF;
    RETURN jsonb_build_object('success', true, 'message', '削除しました', 'deleted', v_deleted);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, pg_temp;

GRANT EXECUTE ON FUNCTION delete_request_by_contract(TEXT, UUID) TO anon;

-- =========================================================
-- purge_old_requests_by_contract
--   days より古い 承認済/却下 申請を削除 (承認待ちは残す)
-- =========================================================
CREATE OR REPLACE FUNCTION purge_old_requests_by_contract(
    p_contract_id TEXT,
    p_days INTEGER DEFAULT 90
) RETURNS JSONB AS $$
DECLARE
    v_org_id UUID;
    v_days INTEGER;
    v_deleted INTEGER;
BEGIN
    IF p_contract_id IS NULL OR p_contract_id = '' THEN
        RETURN jsonb_build_object('success', false, 'message', 'パラメータ不足');
    END IF;
    v_days := COALESCE(p_days, 90);
    -- 範囲チェック: 7日未満や 3650日超は拒否
    IF v_days < 7 OR v_days > 3650 THEN
        RETURN jsonb_build_object('success', false, 'message', 'days は 7〜3650');
    END IF;
    SELECT organization_id INTO v_org_id FROM config WHERE contract_id = p_contract_id;
    IF v_org_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'message', '契約が見つかりません');
    END IF;

    WITH d AS (
        DELETE FROM requests
        WHERE organization_id = v_org_id
          AND status IN ('approved', 'rejected')
          AND created_at < now() - (v_days || ' days')::INTERVAL
        RETURNING 1
    )
    SELECT count(*) INTO v_deleted FROM d;

    RETURN jsonb_build_object(
        'success', true,
        'deleted', v_deleted,
        'cutoff_days', v_days,
        'message', v_deleted::TEXT || '件削除しました'
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, pg_temp;

GRANT EXECUTE ON FUNCTION purge_old_requests_by_contract(TEXT, INTEGER) TO anon;

NOTIFY pgrst, 'reload schema';
