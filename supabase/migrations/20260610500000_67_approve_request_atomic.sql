-- 67_approve_request_atomic.sql
-- ===========================================================
-- v3.7.138: 申請承認をアトミックに実行する RPC
--
-- 背景:
--   旧フロント (js/app_v2.js handleRequest) では
--     1. _requestUpdateStatus(id, 'approved')
--     2. _shiftUpsert(staff_id, date, ...)
--     3. upsert_staff_by_contract(unavailable_dates)
--   と 3 RPC を逐次呼び出していた。途中で失敗すると requests は
--   approved だが shifts が無い不整合が発生していた。
--
-- 修正:
--   approve_request_atomic_by_contract で 1 トランザクションに統合。
--   - 出勤申請 (type=work) → shifts に行を追加
--   - 休み申請 (type=off)  → staff.unavailable_dates に日付追加
--   - 失敗時は自動 ROLLBACK
--
-- 注:
--   announcements テーブルは「運営からの全テナント向け一斉配信」
--   用途であり、全テナント可視は仕様内 (機密データを混入しない運用)。
--   将来「テナント内お知らせ」が必要になったら別 RPC で実装する。
-- ===========================================================

CREATE OR REPLACE FUNCTION approve_request_atomic_by_contract(
    p_contract_id TEXT,
    p_request_id UUID
) RETURNS JSONB AS $$
DECLARE
    v_org_id UUID;
    v_req RECORD;
    v_staff RECORD;
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

    -- v3.7.138: 申請行をロック (同時承認の競合防止)
    SELECT * INTO v_req
    FROM requests
    WHERE id = p_request_id AND organization_id = v_org_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'message', '申請が見つかりません');
    END IF;

    IF v_req.status = 'approved' THEN
        -- 既に承認済 → 冪等的成功
        RETURN jsonb_build_object('success', true, 'message', '既に承認済みです', 'already_approved', true);
    END IF;
    IF v_req.status = 'rejected' THEN
        RETURN jsonb_build_object('success', false, 'message', '却下済みの申請は承認できません');
    END IF;

    -- 申請を承認に変更
    UPDATE requests SET status = 'approved'
    WHERE id = p_request_id AND organization_id = v_org_id;

    -- 出勤申請 → shifts に追加
    IF v_req.type = 'work' AND v_req.dates IS NOT NULL AND array_length(v_req.dates, 1) > 0 THEN
        FOREACH v_d IN ARRAY v_req.dates LOOP
            IF v_d IS NULL OR length(v_d) = 0 THEN CONTINUE; END IF;
            -- 既存シフトがあればスキップ
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

    -- 休み申請 → staff.unavailable_dates に追加
    IF v_req.type = 'off' AND v_req.dates IS NOT NULL AND array_length(v_req.dates, 1) > 0 THEN
        SELECT unavailable_dates INTO v_existing_dates
        FROM staff WHERE id = v_req.staff_id AND organization_id = v_org_id
        FOR UPDATE;
        IF FOUND THEN
            v_new_dates := COALESCE(v_existing_dates, '{}'::TEXT[]);
            FOREACH v_d IN ARRAY v_req.dates LOOP
                IF v_d IS NULL OR length(v_d) = 0 THEN CONTINUE; END IF;
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
        'type', v_req.type
    );
EXCEPTION WHEN OTHERS THEN
    -- 自動 ROLLBACK + 詳細
    RETURN jsonb_build_object(
        'success', false,
        'message', '承認処理中にエラー: ' || SQLERRM
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, pg_temp;

GRANT EXECUTE ON FUNCTION approve_request_atomic_by_contract(TEXT, UUID) TO anon;

NOTIFY pgrst, 'reload schema';
