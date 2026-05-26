-- 48_session_less_shifts_requests_rpc.sql
-- ===========================================================
-- シフト・希望休申請を contract_id だけで操作できる session-less RPC 群。
-- migration 47 (staff) と同じ思想で、RLS 拒否状態でもアプリが動作可能。
-- ===========================================================

-- ===== シフト: 単一 upsert =====
CREATE OR REPLACE FUNCTION upsert_shift_by_contract(
    p_contract_id TEXT,
    p_shift_id UUID,
    p_data JSONB
) RETURNS JSONB AS $$
DECLARE
    v_org_id UUID;
    v_new_id UUID;
BEGIN
    IF p_contract_id IS NULL OR p_contract_id = '' THEN
        RETURN jsonb_build_object('success', false, 'message', 'contract_id is required');
    END IF;

    SELECT organization_id INTO v_org_id FROM config WHERE contract_id = p_contract_id;
    IF v_org_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'message', 'contract not found');
    END IF;

    IF p_shift_id IS NOT NULL THEN
        UPDATE shifts SET
            staff_id = COALESCE((p_data->>'staff_id')::UUID, staff_id),
            date = COALESCE(p_data->>'date', date),
            start_time = COALESCE(p_data->>'start_time', start_time),
            end_time = COALESCE(p_data->>'end_time', end_time),
            break_minutes = COALESCE((p_data->>'break_minutes')::INTEGER, break_minutes),
            memo = COALESCE(p_data->>'memo', memo),
            is_irregular = COALESCE((p_data->>'is_irregular')::BOOLEAN, is_irregular)
        WHERE id = p_shift_id AND organization_id = v_org_id;

        IF NOT FOUND THEN
            RETURN jsonb_build_object('success', false, 'message', 'shift not found or org mismatch');
        END IF;
        RETURN jsonb_build_object('success', true, 'shift_id', p_shift_id, 'mode', 'update');
    ELSE
        INSERT INTO shifts (
            organization_id, staff_id, date, start_time, end_time, break_minutes, memo, is_irregular
        ) VALUES (
            v_org_id,
            (p_data->>'staff_id')::UUID,
            p_data->>'date',
            p_data->>'start_time',
            p_data->>'end_time',
            COALESCE((p_data->>'break_minutes')::INTEGER, 60),
            p_data->>'memo',
            COALESCE((p_data->>'is_irregular')::BOOLEAN, FALSE)
        ) RETURNING id INTO v_new_id;
        RETURN jsonb_build_object('success', true, 'shift_id', v_new_id, 'mode', 'insert');
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, extensions, pg_temp;
GRANT EXECUTE ON FUNCTION upsert_shift_by_contract(TEXT, UUID, JSONB) TO anon;

-- ===== シフト: 削除 (単一) =====
CREATE OR REPLACE FUNCTION delete_shift_by_contract(
    p_contract_id TEXT,
    p_shift_id UUID
) RETURNS JSONB AS $$
DECLARE v_org_id UUID;
BEGIN
    SELECT organization_id INTO v_org_id FROM config WHERE contract_id = p_contract_id;
    IF v_org_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'message', 'contract not found');
    END IF;
    DELETE FROM shifts WHERE id = p_shift_id AND organization_id = v_org_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'message', 'shift not found');
    END IF;
    RETURN jsonb_build_object('success', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, extensions, pg_temp;
GRANT EXECUTE ON FUNCTION delete_shift_by_contract(TEXT, UUID) TO anon;

-- ===== シフト: 一括 INSERT (AI生成保存用) =====
CREATE OR REPLACE FUNCTION bulk_insert_shifts_by_contract(
    p_contract_id TEXT,
    p_shifts JSONB
) RETURNS JSONB AS $$
DECLARE
    v_org_id UUID;
    v_inserted INTEGER := 0;
    v_row JSONB;
BEGIN
    SELECT organization_id INTO v_org_id FROM config WHERE contract_id = p_contract_id;
    IF v_org_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'message', 'contract not found');
    END IF;
    IF jsonb_typeof(p_shifts) <> 'array' THEN
        RETURN jsonb_build_object('success', false, 'message', 'p_shifts must be a JSON array');
    END IF;

    FOR v_row IN SELECT * FROM jsonb_array_elements(p_shifts) LOOP
        INSERT INTO shifts (
            organization_id, staff_id, date, start_time, end_time, break_minutes, memo, is_irregular
        ) VALUES (
            v_org_id,
            (v_row->>'staff_id')::UUID,
            v_row->>'date',
            v_row->>'start_time',
            v_row->>'end_time',
            COALESCE((v_row->>'break_minutes')::INTEGER, 60),
            v_row->>'memo',
            COALESCE((v_row->>'is_irregular')::BOOLEAN, FALSE)
        );
        v_inserted := v_inserted + 1;
    END LOOP;

    RETURN jsonb_build_object('success', true, 'inserted', v_inserted);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, extensions, pg_temp;
GRANT EXECUTE ON FUNCTION bulk_insert_shifts_by_contract(TEXT, JSONB) TO anon;

-- ===== シフト: 一括 DELETE (AI再生成用) =====
CREATE OR REPLACE FUNCTION bulk_delete_shifts_by_contract(
    p_contract_id TEXT,
    p_shift_ids JSONB
) RETURNS JSONB AS $$
DECLARE
    v_org_id UUID;
    v_deleted INTEGER := 0;
    v_id UUID;
BEGIN
    SELECT organization_id INTO v_org_id FROM config WHERE contract_id = p_contract_id;
    IF v_org_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'message', 'contract not found');
    END IF;
    IF jsonb_typeof(p_shift_ids) <> 'array' THEN
        RETURN jsonb_build_object('success', false, 'message', 'p_shift_ids must be a JSON array');
    END IF;

    FOR v_id IN SELECT (v::TEXT)::UUID FROM jsonb_array_elements_text(p_shift_ids) v LOOP
        DELETE FROM shifts WHERE id = v_id AND organization_id = v_org_id;
        IF FOUND THEN v_deleted := v_deleted + 1; END IF;
    END LOOP;

    RETURN jsonb_build_object('success', true, 'deleted', v_deleted);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, extensions, pg_temp;
GRANT EXECUTE ON FUNCTION bulk_delete_shifts_by_contract(TEXT, JSONB) TO anon;

-- ===== シフト: 一覧取得 (期間絞り込み) =====
CREATE OR REPLACE FUNCTION list_shifts_by_contract(
    p_contract_id TEXT,
    p_from TEXT DEFAULT NULL,
    p_to TEXT DEFAULT NULL
) RETURNS SETOF shifts AS $$
DECLARE v_org_id UUID;
BEGIN
    SELECT organization_id INTO v_org_id FROM config WHERE contract_id = p_contract_id;
    IF v_org_id IS NULL THEN RETURN; END IF;
    RETURN QUERY
        SELECT * FROM shifts
        WHERE organization_id = v_org_id
          AND (p_from IS NULL OR date >= p_from)
          AND (p_to IS NULL OR date <= p_to)
        ORDER BY date, start_time;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, extensions, pg_temp;
GRANT EXECUTE ON FUNCTION list_shifts_by_contract(TEXT, TEXT, TEXT) TO anon;

-- ===== 申請 (requests): 作成 =====
CREATE OR REPLACE FUNCTION insert_request_by_contract(
    p_contract_id TEXT,
    p_data JSONB
) RETURNS JSONB AS $$
DECLARE
    v_org_id UUID;
    v_new_id UUID;
BEGIN
    SELECT organization_id INTO v_org_id FROM config WHERE contract_id = p_contract_id;
    IF v_org_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'message', 'contract not found');
    END IF;

    INSERT INTO requests (
        organization_id, staff_id, type, dates, start_time, end_time, reason, status
    ) VALUES (
        v_org_id,
        (p_data->>'staff_id')::UUID,
        COALESCE(p_data->>'type', 'leave'),
        COALESCE(p_data->>'dates', ''),
        p_data->>'start_time',
        p_data->>'end_time',
        p_data->>'reason',
        COALESCE(p_data->>'status', 'pending')
    ) RETURNING id INTO v_new_id;

    RETURN jsonb_build_object('success', true, 'request_id', v_new_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, extensions, pg_temp;
GRANT EXECUTE ON FUNCTION insert_request_by_contract(TEXT, JSONB) TO anon;

-- ===== 申請: ステータス更新 (承認/却下) =====
CREATE OR REPLACE FUNCTION update_request_status_by_contract(
    p_contract_id TEXT,
    p_request_id UUID,
    p_status TEXT
) RETURNS JSONB AS $$
DECLARE v_org_id UUID;
BEGIN
    SELECT organization_id INTO v_org_id FROM config WHERE contract_id = p_contract_id;
    IF v_org_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'message', 'contract not found');
    END IF;
    UPDATE requests SET status = p_status
        WHERE id = p_request_id AND organization_id = v_org_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'message', 'request not found');
    END IF;
    RETURN jsonb_build_object('success', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, extensions, pg_temp;
GRANT EXECUTE ON FUNCTION update_request_status_by_contract(TEXT, UUID, TEXT) TO anon;

-- ===== 申請: 一覧 =====
CREATE OR REPLACE FUNCTION list_requests_by_contract(p_contract_id TEXT)
RETURNS SETOF requests AS $$
DECLARE v_org_id UUID;
BEGIN
    SELECT organization_id INTO v_org_id FROM config WHERE contract_id = p_contract_id;
    IF v_org_id IS NULL THEN RETURN; END IF;
    RETURN QUERY SELECT * FROM requests WHERE organization_id = v_org_id ORDER BY created_at DESC;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, extensions, pg_temp;
GRANT EXECUTE ON FUNCTION list_requests_by_contract(TEXT) TO anon;

NOTIFY pgrst, 'reload schema';
