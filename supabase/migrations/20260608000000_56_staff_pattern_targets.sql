-- 56_staff_pattern_targets.sql
-- ===========================================================
-- v3.7.77: スタッフごとのシフトパターン月間目標回数
--   - staff.pattern_target_counts JSONB を追加
--     例: { "早番": 3, "遅番": 3, "夜勤": 3 }
--   - upsert_staff_by_contract を更新して新カラムを受け付ける
--     (migration 52 の構造を踏襲: p_data ? 'key' で NULL も明示更新可能)
--   - scheduler.py 側で目標値からの差分を Tier4 ソフト制約として扱う
-- ===========================================================

ALTER TABLE staff
    ADD COLUMN IF NOT EXISTS pattern_target_counts JSONB DEFAULT '{}'::jsonb;

COMMENT ON COLUMN staff.pattern_target_counts IS
    'シフトパターン別の月間目標出勤回数。キーはパターン名、値は整数。';

-- upsert_staff_by_contract を pattern_target_counts 対応版で再定義
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

    IF p_data ? 'unavailable_dates' THEN
        v_clean_dates := COALESCE(
            ARRAY(
                SELECT d
                FROM jsonb_array_elements_text(p_data->'unavailable_dates') AS d
                WHERE trim(d) ~ '^\d{4}-\d{2}-\d{2}$'
                  AND _is_valid_iso_date(trim(d))
            ),
            '{}'::TEXT[]
        );
    END IF;

    IF p_staff_id IS NOT NULL THEN
        UPDATE staff SET
            name             = CASE WHEN p_data ? 'name'             THEN p_data->>'name'             ELSE name END,
            role             = CASE WHEN p_data ? 'role'             THEN p_data->>'role'             ELSE role END,
            evaluation       = CASE WHEN p_data ? 'evaluation'       THEN p_data->>'evaluation'       ELSE evaluation END,
            salary_type      = CASE WHEN p_data ? 'salary_type'      THEN p_data->>'salary_type'      ELSE salary_type END,
            hourly_wage      = CASE WHEN p_data ? 'hourly_wage'      THEN (p_data->>'hourly_wage')::INTEGER      ELSE hourly_wage END,
            monthly_salary   = CASE WHEN p_data ? 'monthly_salary'   THEN (p_data->>'monthly_salary')::INTEGER   ELSE monthly_salary END,
            annual_holidays  = CASE WHEN p_data ? 'annual_holidays'  THEN (p_data->>'annual_holidays')::INTEGER  ELSE annual_holidays END,
            max_days_week    = CASE WHEN p_data ? 'max_days_week'    THEN (p_data->>'max_days_week')::INTEGER    ELSE max_days_week END,
            max_hours_day    = CASE WHEN p_data ? 'max_hours_day'    THEN (p_data->>'max_hours_day')::INTEGER    ELSE max_hours_day END,
            min_days_week    = CASE WHEN p_data ? 'min_days_week'    THEN (p_data->>'min_days_week')::INTEGER    ELSE min_days_week END,
            min_days_month   = CASE WHEN p_data ? 'min_days_month'   THEN (p_data->>'min_days_month')::INTEGER   ELSE min_days_month END,
            shift_priority   = CASE WHEN p_data ? 'shift_priority'   THEN p_data->>'shift_priority'   ELSE shift_priority END,
            contract_type    = CASE WHEN p_data ? 'contract_type'    THEN p_data->>'contract_type'    ELSE contract_type END,
            pref_start_wd    = CASE WHEN p_data ? 'pref_start_wd'    THEN p_data->>'pref_start_wd'    ELSE pref_start_wd END,
            pref_end_wd      = CASE WHEN p_data ? 'pref_end_wd'      THEN p_data->>'pref_end_wd'      ELSE pref_end_wd END,
            pref_start_we    = CASE WHEN p_data ? 'pref_start_we'    THEN p_data->>'pref_start_we'    ELSE pref_start_we END,
            pref_end_we      = CASE WHEN p_data ? 'pref_end_we'      THEN p_data->>'pref_end_we'      ELSE pref_end_we END,
            ng_pairs         = CASE WHEN p_data ? 'ng_pairs'         THEN p_data->>'ng_pairs'         ELSE ng_pairs END,
            req_pairs        = CASE WHEN p_data ? 'req_pairs'        THEN p_data->>'req_pairs'        ELSE req_pairs END,
            position         = CASE WHEN p_data ? 'position'         THEN p_data->>'position'         ELSE position END,
            ng_weekdays      = CASE
                WHEN p_data ? 'ng_weekdays'
                    THEN ARRAY(SELECT jsonb_array_elements_text(p_data->'ng_weekdays')::INTEGER)
                ELSE ng_weekdays
            END,
            unavailable_dates = CASE
                WHEN p_data ? 'unavailable_dates' THEN v_clean_dates
                ELSE unavailable_dates
            END,
            -- v3.7.77: 新カラム
            pattern_target_counts = CASE
                WHEN p_data ? 'pattern_target_counts' THEN p_data->'pattern_target_counts'
                ELSE pattern_target_counts
            END
        WHERE id = p_staff_id AND organization_id = v_org_id;

        IF NOT FOUND THEN
            RETURN jsonb_build_object('success', false, 'message', 'staff not found or org mismatch');
        END IF;
        RETURN jsonb_build_object('success', true, 'staff_id', p_staff_id, 'mode', 'update');
    ELSE
        INSERT INTO staff (
            organization_id, contract_id, name, role, evaluation,
            salary_type, hourly_wage, monthly_salary, annual_holidays,
            max_days_week, max_hours_day, min_days_week, min_days_month,
            shift_priority, contract_type,
            pref_start_wd, pref_end_wd, pref_start_we, pref_end_we,
            ng_pairs, req_pairs, position, ng_weekdays,
            unavailable_dates,
            pattern_target_counts
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
            COALESCE(v_clean_dates, '{}'::TEXT[]),
            COALESCE(p_data->'pattern_target_counts', '{}'::jsonb)
        ) RETURNING id INTO v_new_id;

        RETURN jsonb_build_object('success', true, 'staff_id', v_new_id, 'mode', 'insert');
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, pg_temp;

GRANT EXECUTE ON FUNCTION upsert_staff_by_contract(TEXT, UUID, JSONB) TO anon;

-- config_safe view にも pattern_target_counts を含めて読み出し可能にする
-- (注: 既存 view 定義を確認せずに変更すると壊れるため、ここでは ALTER のみ。
--      Supabase の REST API は staff テーブルから自動的に取得するため、
--      明示的な view 変更は不要)

NOTIFY pgrst, 'reload schema';
