-- 70_delete_request_undo.sql
-- ===========================================================
-- v3.7.153: 申請削除時に「承認の影響も undo」するよう強化
--   - 承認済み 出勤希望 (work) → 関連 shifts を削除
--   - 承認済み 休み希望 (off/holiday) → staff.unavailable_dates から該当日を除外
--   - pending / rejected は requests テーブルのみ削除
-- ===========================================================

CREATE OR REPLACE FUNCTION delete_request_by_contract(
    p_contract_id TEXT,
    p_request_id UUID
) RETURNS JSONB AS $$
DECLARE
    v_org_id UUID;
    v_req RECORD;
    v_dates_arr TEXT[];
    v_d TEXT;
    v_existing_dates TEXT[];
    v_new_dates TEXT[];
    v_shifts_deleted INTEGER := 0;
BEGIN
    IF p_contract_id IS NULL OR p_contract_id = '' OR p_request_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'message', 'パラメータ不足');
    END IF;
    SELECT organization_id INTO v_org_id FROM config WHERE contract_id = p_contract_id;
    IF v_org_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'message', '契約が見つかりません');
    END IF;

    -- 申請を取得 (ロック)
    SELECT * INTO v_req
    FROM requests
    WHERE id = p_request_id AND organization_id = v_org_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'message', '申請が見つかりません');
    END IF;

    -- 承認済みの場合、影響を undo
    IF v_req.status = 'approved' THEN
        -- dates をパース
        v_dates_arr := ARRAY(
            SELECT trim(d) FROM unnest(string_to_array(COALESCE(v_req.dates, ''), ',')) AS d
            WHERE trim(d) <> '' AND trim(d) ~ '^\d{4}-\d{2}-\d{2}$'
        );

        IF v_req.type = 'work' AND array_length(v_dates_arr, 1) > 0 THEN
            -- 該当 staff の該当日の shifts を削除
            WITH d AS (
                DELETE FROM shifts
                WHERE staff_id = v_req.staff_id
                  AND organization_id = v_org_id
                  AND date = ANY(v_dates_arr)
                RETURNING 1
            )
            SELECT count(*) INTO v_shifts_deleted FROM d;

        ELSIF v_req.type IN ('off', 'holiday') AND array_length(v_dates_arr, 1) > 0 THEN
            -- staff.unavailable_dates から該当日を除外
            SELECT unavailable_dates INTO v_existing_dates
            FROM staff WHERE id = v_req.staff_id AND organization_id = v_org_id
            FOR UPDATE;
            IF FOUND THEN
                v_new_dates := COALESCE(v_existing_dates, '{}'::TEXT[]);
                FOREACH v_d IN ARRAY v_dates_arr LOOP
                    v_new_dates := array_remove(v_new_dates, v_d);
                END LOOP;
                UPDATE staff SET unavailable_dates = v_new_dates
                WHERE id = v_req.staff_id AND organization_id = v_org_id;
            END IF;
        END IF;
    END IF;

    -- 申請本体を削除
    DELETE FROM requests
    WHERE id = p_request_id AND organization_id = v_org_id;

    RETURN jsonb_build_object(
        'success', true,
        'message', '削除しました',
        'undid_status', v_req.status,
        'shifts_deleted', v_shifts_deleted
    );
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object(
        'success', false,
        'message', '削除中にエラー: ' || SQLERRM
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, pg_temp;

NOTIFY pgrst, 'reload schema';
