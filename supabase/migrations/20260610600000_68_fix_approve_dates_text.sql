-- 68_fix_approve_dates_text.sql
-- ===========================================================
-- v3.7.147: approve_request_atomic_by_contract のバグ修正
--
-- ユーザー報告:
--   承認処理中にエラー: function array_length(text, integer) does not exist
--
-- 原因:
--   migration 67 で v_req.dates を TEXT[] 配列と仮定して array_length を
--   呼んでいたが、requests.dates カラムは実際は TEXT (カンマ区切り) だった。
--
-- 修正:
--   v_req.dates を string_to_array で TEXT[] に変換してからループ。
-- ===========================================================

CREATE OR REPLACE FUNCTION approve_request_atomic_by_contract(
    p_contract_id TEXT,
    p_request_id UUID
) RETURNS JSONB AS $$
DECLARE
    v_org_id UUID;
    v_req RECORD;
    v_dates_arr TEXT[];
    v_existing_dates TEXT[];
    v_d TEXT;
    v_new_dates TEXT[];
BEGIN
    IF p_contract_id IS NULL OR p_contract_id = ''
       OR p_request_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'message', 'パラメータ不足');
    END IF;

    SELECT organization_id INTO v_org_id
    FROM config WHERE contract_id = p_contract_id;
    IF v_org_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'message', '契約が見つかりません');
    END IF;

    SELECT * INTO v_req
    FROM requests
    WHERE id = p_request_id AND organization_id = v_org_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'message', '申請が見つかりません');
    END IF;

    IF v_req.status = 'approved' THEN
        RETURN jsonb_build_object('success', true, 'message', '既に承認済みです', 'already_approved', true);
    END IF;
    IF v_req.status = 'rejected' THEN
        RETURN jsonb_build_object('success', false, 'message', '却下済みの申請は承認できません');
    END IF;

    UPDATE requests SET status = 'approved'
    WHERE id = p_request_id AND organization_id = v_org_id;

    -- v3.7.147: dates は TEXT (カンマ区切り) なので string_to_array で配列化
    v_dates_arr := ARRAY(
        SELECT trim(d) FROM unnest(string_to_array(COALESCE(v_req.dates, ''), ',')) AS d
        WHERE trim(d) <> '' AND trim(d) ~ '^\d{4}-\d{2}-\d{2}$'
    );

    -- 出勤申請 → shifts に追加
    IF v_req.type = 'work' AND array_length(v_dates_arr, 1) > 0 THEN
        FOREACH v_d IN ARRAY v_dates_arr LOOP
            IF NOT EXISTS (
                SELECT 1 FROM shifts
                WHERE staff_id = v_req.staff_id AND date = v_d
                  AND organization_id = v_org_id
            ) THEN
                INSERT INTO shifts (
                    organization_id, staff_id, date,
                    start_time, end_time, break_minutes
                ) VALUES (
                    v_org_id, v_req.staff_id, v_d,
                    COALESCE(v_req.start_time, '09:00'),
                    COALESCE(v_req.end_time, '18:00'),
                    0
                );
            END IF;
        END LOOP;
    END IF;

    -- 休み申請 → staff.unavailable_dates に追加 (unavailable_dates も TEXT[])
    IF v_req.type IN ('off', 'holiday') AND array_length(v_dates_arr, 1) > 0 THEN
        SELECT unavailable_dates INTO v_existing_dates
        FROM staff WHERE id = v_req.staff_id AND organization_id = v_org_id
        FOR UPDATE;
        IF FOUND THEN
            v_new_dates := COALESCE(v_existing_dates, '{}'::TEXT[]);
            FOREACH v_d IN ARRAY v_dates_arr LOOP
                IF NOT (v_d = ANY(v_new_dates)) THEN
                    v_new_dates := array_append(v_new_dates, v_d);
                END IF;
            END LOOP;
            UPDATE staff SET unavailable_dates = v_new_dates
            WHERE id = v_req.staff_id AND organization_id = v_org_id;
        END IF;
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'message', '承認しました',
        'request_id', p_request_id,
        'type', v_req.type,
        'dates_count', COALESCE(array_length(v_dates_arr, 1), 0)
    );
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object(
        'success', false,
        'message', '承認処理中にエラー: ' || SQLERRM
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, pg_temp;

NOTIFY pgrst, 'reload schema';
