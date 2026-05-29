-- 52_upsert_staff_null_safe.sql
-- ===========================================================
-- upsert_staff_by_contract の修正 + 無効日付クリーンアップ。
--
-- ディープデバッグで発見した HIGH 優先度バグ:
--   1. UPDATE 時の COALESCE で NULL 更新ができない
--      フロントから「希望時間を削除」したいとき pref_start_wd=null を送るが、
--      COALESCE(NULL, 既存値) で既存値が残り削除されない。
--      対策: JSONB ? 演算子で KEY 存在を判定し、明示的に NULL を受け入れる。
--
--   2. 無効日付が unavailable_dates に残る可能性
--      migration 50 の正規表現 '^\d{4}-\d{2}-\d{2}$' は形式のみチェックで、
--      "2026-13-32" 等の不正日付が通過。シフト生成エンジン側で
--      datetime.strptime に渡してエラーになるリスク。
--      対策: 補助関数 _is_valid_iso_date で DATE 型キャスト可能性を検証。
-- ===========================================================

-- 補助関数: ISO 日付文字列が DATE 型に変換可能かチェック
CREATE OR REPLACE FUNCTION _is_valid_iso_date(p_str TEXT)
RETURNS BOOLEAN AS $$
BEGIN
    PERFORM p_str::DATE;
    RETURN TRUE;
EXCEPTION WHEN OTHERS THEN
    RETURN FALSE;
END;
$$ LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog, public, extensions, pg_temp;

-- 既存データの再クリーンアップ (migration 50 後に残った無効日付を除去)
UPDATE staff
SET unavailable_dates = COALESCE(
    ARRAY(
        SELECT d
        FROM unnest(unavailable_dates) AS d
        WHERE trim(d) ~ '^\d{4}-\d{2}-\d{2}$'
          AND _is_valid_iso_date(trim(d))
    ),
    '{}'::TEXT[]
)
WHERE unavailable_dates IS NOT NULL
  AND EXISTS (
      SELECT 1 FROM unnest(unavailable_dates) AS d
      WHERE NOT _is_valid_iso_date(trim(d))
  );

-- upsert_staff_by_contract の COALESCE 問題を解消
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

    -- unavailable_dates が送られてきた場合、日付形式 + DATE キャスト可能性を検証
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
        -- 更新: KEY 存在判定で NULL も受け入れる (COALESCE フォールバックを廃止)
        -- 「希望時間削除」等のために、明示的に NULL を送ったら NULL に更新する必要がある
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
            -- 新カラム (migration 50)
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
            END
        WHERE id = p_staff_id AND organization_id = v_org_id;

        IF NOT FOUND THEN
            RETURN jsonb_build_object('success', false, 'message', 'staff not found or org mismatch');
        END IF;
        RETURN jsonb_build_object('success', true, 'staff_id', p_staff_id, 'mode', 'update');
    ELSE
        -- 新規作成: 各カラムは COALESCE で安全なデフォルト
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
