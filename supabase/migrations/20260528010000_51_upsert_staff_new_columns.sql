-- 51_upsert_staff_new_columns.sql
-- ===========================================================
-- upsert_staff_by_contract RPC を migration 50 で追加した新カラムに対応。
-- pref_start_wd/end_wd/start_we/end_we, ng_pairs, req_pairs, position,
-- ng_weekdays を受け付ける。
--
-- 互換性:
--   - 旧フロントエンド (タグ形式) からの呼び出しは unavailable_dates 経由で
--     引き続き受け付ける (タグは新カラムに保存され、unavailable_dates 自体は
--     日付のみが残る)
--   - 新フロントエンドは新カラムを直接送信する
-- ===========================================================

CREATE OR REPLACE FUNCTION upsert_staff_by_contract(
    p_contract_id TEXT,
    p_staff_id UUID,
    p_data JSONB
) RETURNS JSONB AS $$
DECLARE
    v_org_id UUID;
    v_new_id UUID;
    v_clean_dates TEXT[];
BEGIN
    IF p_contract_id IS NULL OR p_contract_id = '' THEN
        RETURN jsonb_build_object('success', false, 'message', 'contract_id is required');
    END IF;

    SELECT organization_id INTO v_org_id
    FROM config
    WHERE contract_id = p_contract_id;

    IF v_org_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'message', 'contract not found');
    END IF;

    -- unavailable_dates が送られてきた場合、日付のみを抽出してクリーン化
    -- (タグ形式 priority:high などは新カラムに送られている前提で除外)
    IF p_data ? 'unavailable_dates' THEN
        v_clean_dates := COALESCE(
            ARRAY(
                SELECT d
                FROM jsonb_array_elements_text(p_data->'unavailable_dates') AS d
                WHERE trim(d) ~ '^\d{4}-\d{2}-\d{2}$'
            ),
            '{}'::TEXT[]
        );
    END IF;

    IF p_staff_id IS NOT NULL THEN
        -- 更新
        UPDATE staff SET
            name             = COALESCE(p_data->>'name', name),
            role             = COALESCE(p_data->>'role', role),
            evaluation       = COALESCE(p_data->>'evaluation', evaluation),
            salary_type      = COALESCE(p_data->>'salary_type', salary_type),
            hourly_wage      = COALESCE((p_data->>'hourly_wage')::INTEGER, hourly_wage),
            monthly_salary   = COALESCE((p_data->>'monthly_salary')::INTEGER, monthly_salary),
            annual_holidays  = COALESCE((p_data->>'annual_holidays')::INTEGER, annual_holidays),
            max_days_week    = COALESCE((p_data->>'max_days_week')::INTEGER, max_days_week),
            max_hours_day    = COALESCE((p_data->>'max_hours_day')::INTEGER, max_hours_day),
            min_days_week    = COALESCE((p_data->>'min_days_week')::INTEGER, min_days_week),
            min_days_month   = COALESCE((p_data->>'min_days_month')::INTEGER, min_days_month),
            shift_priority   = COALESCE(p_data->>'shift_priority', shift_priority),
            contract_type    = COALESCE(p_data->>'contract_type', contract_type),
            -- 新カラム (migration 50)
            pref_start_wd    = COALESCE(p_data->>'pref_start_wd', pref_start_wd),
            pref_end_wd      = COALESCE(p_data->>'pref_end_wd', pref_end_wd),
            pref_start_we    = COALESCE(p_data->>'pref_start_we', pref_start_we),
            pref_end_we      = COALESCE(p_data->>'pref_end_we', pref_end_we),
            ng_pairs         = COALESCE(p_data->>'ng_pairs', ng_pairs),
            req_pairs        = COALESCE(p_data->>'req_pairs', req_pairs),
            position         = COALESCE(p_data->>'position', position),
            ng_weekdays      = CASE
                WHEN p_data ? 'ng_weekdays'
                    THEN ARRAY(SELECT jsonb_array_elements_text(p_data->'ng_weekdays')::INTEGER)
                ELSE ng_weekdays
            END,
            unavailable_dates = CASE
                WHEN p_data ? 'unavailable_dates' THEN v_clean_dates
                ELSE unavailable_dates
            END
        WHERE id = p_staff_id AND organization_id = v_org_id;

        IF NOT FOUND THEN
            RETURN jsonb_build_object('success', false, 'message', 'staff not found or org mismatch');
        END IF;
        RETURN jsonb_build_object('success', true, 'staff_id', p_staff_id, 'mode', 'update');
    ELSE
        -- 新規作成
        INSERT INTO staff (
            organization_id, contract_id, name, role, evaluation,
            salary_type, hourly_wage, monthly_salary, annual_holidays,
            max_days_week, max_hours_day, min_days_week, min_days_month,
            shift_priority, contract_type,
            pref_start_wd, pref_end_wd, pref_start_we, pref_end_we,
            ng_pairs, req_pairs, position, ng_weekdays,
            unavailable_dates
        ) VALUES (
            v_org_id,
            p_contract_id,
            COALESCE(p_data->>'name', ''),
            COALESCE(p_data->>'role', 'staff'),
            COALESCE(p_data->>'evaluation', 'B'),
            COALESCE(p_data->>'salary_type', 'hourly'),
            COALESCE((p_data->>'hourly_wage')::INTEGER, 1100),
            COALESCE((p_data->>'monthly_salary')::INTEGER, 0),
            COALESCE((p_data->>'annual_holidays')::INTEGER, 105),
            COALESCE((p_data->>'max_days_week')::INTEGER, 5),
            COALESCE((p_data->>'max_hours_day')::INTEGER, 8),
            COALESCE((p_data->>'min_days_week')::INTEGER, 0),
            COALESCE((p_data->>'min_days_month')::INTEGER, 0),
            COALESCE(p_data->>'shift_priority', 'medium'),
            COALESCE(p_data->>'contract_type', 'general'),
            p_data->>'pref_start_wd',
            p_data->>'pref_end_wd',
            p_data->>'pref_start_we',
            p_data->>'pref_end_we',
            p_data->>'ng_pairs',
            p_data->>'req_pairs',
            COALESCE(p_data->>'position', 'any'),
            CASE
                WHEN p_data ? 'ng_weekdays'
                    THEN ARRAY(SELECT jsonb_array_elements_text(p_data->'ng_weekdays')::INTEGER)
                ELSE '{}'::INTEGER[]
            END,
            COALESCE(v_clean_dates, '{}'::TEXT[])
        ) RETURNING id INTO v_new_id;

        RETURN jsonb_build_object('success', true, 'staff_id', v_new_id, 'mode', 'insert');
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, pg_temp;

GRANT EXECUTE ON FUNCTION upsert_staff_by_contract(TEXT, UUID, JSONB) TO anon;

NOTIFY pgrst, 'reload schema';
