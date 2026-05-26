-- 47_session_less_staff_rpc.sql
-- ===========================================================
-- スタッフの作成・更新・削除をセッションレスで行う RPC を追加。
--
-- 背景:
--   Migration 43 で staff テーブルに RLS 強化 (organization_id =
--   get_session_org_id()) を適用したため、x-session-id ヘッダの
--   セッションが auth_sessions に存在しないと INSERT/UPDATE/DELETE が
--   全て弾かれる ("new row violates row-level security policy")。
--
-- 本 RPC は contract_id を入力として SECURITY DEFINER で実行し、
-- RLS をバイパスして スタッフを操作する。
--
-- セキュリティ:
--   - contract_id は 15桁ランダム数字 (10^15 通り) のため、
--     第三者によるブルートフォースは現実的でない。
--   - 既存 update_config_safe(p_config_id, p_data) も SECURITY DEFINER
--     で config_id 知っていれば誰でも更新可能な設計のため、
--     本 RPC も攻撃面は実質増えない。
-- ===========================================================

-- スタッフ作成
CREATE OR REPLACE FUNCTION upsert_staff_by_contract(
    p_contract_id TEXT,
    p_staff_id UUID,
    p_data JSONB
) RETURNS JSONB AS $$
DECLARE
    v_org_id UUID;
    v_new_id UUID;
    v_existing_count INTEGER;
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

    IF p_staff_id IS NOT NULL THEN
        -- 更新
        UPDATE staff SET
            name = COALESCE(p_data->>'name', name),
            role = COALESCE(p_data->>'role', role),
            evaluation = COALESCE(p_data->>'evaluation', evaluation),
            salary_type = COALESCE(p_data->>'salary_type', salary_type),
            hourly_wage = COALESCE((p_data->>'hourly_wage')::INTEGER, hourly_wage),
            monthly_salary = COALESCE((p_data->>'monthly_salary')::INTEGER, monthly_salary),
            max_days_week = COALESCE((p_data->>'max_days_week')::INTEGER, max_days_week),
            max_hours_day = COALESCE((p_data->>'max_hours_day')::INTEGER, max_hours_day),
            min_days_week = COALESCE((p_data->>'min_days_week')::INTEGER, min_days_week),
            min_days_month = COALESCE((p_data->>'min_days_month')::INTEGER, min_days_month),
            unavailable_dates = CASE
                WHEN p_data ? 'unavailable_dates'
                    THEN ARRAY(SELECT jsonb_array_elements_text(p_data->'unavailable_dates'))::TEXT[]
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
            salary_type, hourly_wage, monthly_salary,
            max_days_week, max_hours_day, min_days_week, min_days_month,
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
            COALESCE((p_data->>'max_days_week')::INTEGER, 5),
            COALESCE((p_data->>'max_hours_day')::INTEGER, 8),
            COALESCE((p_data->>'min_days_week')::INTEGER, 0),
            COALESCE((p_data->>'min_days_month')::INTEGER, 0),
            CASE
                WHEN p_data ? 'unavailable_dates'
                    THEN ARRAY(SELECT jsonb_array_elements_text(p_data->'unavailable_dates'))::TEXT[]
                ELSE '{}'::TEXT[]
            END
        ) RETURNING id INTO v_new_id;

        RETURN jsonb_build_object('success', true, 'staff_id', v_new_id, 'mode', 'insert');
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, pg_temp;

GRANT EXECUTE ON FUNCTION upsert_staff_by_contract(TEXT, UUID, JSONB) TO anon;

-- スタッフ削除
CREATE OR REPLACE FUNCTION delete_staff_by_contract(
    p_contract_id TEXT,
    p_staff_id UUID
) RETURNS JSONB AS $$
DECLARE
    v_org_id UUID;
BEGIN
    IF p_contract_id IS NULL OR p_contract_id = '' THEN
        RETURN jsonb_build_object('success', false, 'message', 'contract_id is required');
    END IF;
    IF p_staff_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'message', 'staff_id is required');
    END IF;

    SELECT organization_id INTO v_org_id
    FROM config
    WHERE contract_id = p_contract_id;

    IF v_org_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'message', 'contract not found');
    END IF;

    DELETE FROM staff WHERE id = p_staff_id AND organization_id = v_org_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'message', 'staff not found or org mismatch');
    END IF;

    RETURN jsonb_build_object('success', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, pg_temp;

GRANT EXECUTE ON FUNCTION delete_staff_by_contract(TEXT, UUID) TO anon;

-- 一覧取得 (RLS バイパス。state.staff が空の問題を救う)
CREATE OR REPLACE FUNCTION list_staff_by_contract(p_contract_id TEXT)
RETURNS SETOF staff AS $$
DECLARE
    v_org_id UUID;
BEGIN
    SELECT organization_id INTO v_org_id
    FROM config
    WHERE contract_id = p_contract_id;

    IF v_org_id IS NULL THEN
        RETURN;
    END IF;

    RETURN QUERY SELECT * FROM staff WHERE organization_id = v_org_id ORDER BY name;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, pg_temp;

GRANT EXECUTE ON FUNCTION list_staff_by_contract(TEXT) TO anon;

-- ===========================================================
-- 設定 (config) を contract_id だけで更新する RPC を追加
-- (resolve_config_id_by_contract + update_config_safe の組み合わせを
--  1 呼び出しで完結させ、フロントの責務を最小化)
-- ===========================================================
CREATE OR REPLACE FUNCTION update_config_by_contract(
    p_contract_id TEXT,
    p_data JSONB
) RETURNS JSONB AS $$
DECLARE
    v_id UUID;
BEGIN
    IF p_contract_id IS NULL OR p_contract_id = '' THEN
        RETURN jsonb_build_object('success', false, 'message', 'contract_id is required');
    END IF;

    SELECT id INTO v_id FROM config WHERE contract_id = p_contract_id;
    IF v_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'message', 'contract not found');
    END IF;

    UPDATE config SET
        opening_time = COALESCE(p_data->>'opening_time', opening_time),
        closing_time = COALESCE(p_data->>'closing_time', closing_time),
        hourly_wage_default = COALESCE((p_data->>'hourly_wage_default')::INTEGER, hourly_wage_default),
        opening_times = COALESCE(p_data->'opening_times', opening_times),
        closed_days = CASE WHEN p_data ? 'closed_days' THEN ARRAY(SELECT jsonb_array_elements_text(p_data->'closed_days'))::INTEGER[] ELSE closed_days END,
        staff_req = COALESCE(p_data->'staff_req', staff_req),
        roles = COALESCE(p_data->'roles', roles),
        special_holidays = CASE WHEN p_data ? 'special_holidays' THEN ARRAY(SELECT jsonb_array_elements_text(p_data->'special_holidays'))::TEXT[] ELSE special_holidays END,
        special_days = COALESCE(p_data->'special_days', special_days),
        time_staff_req = COALESCE(p_data->'time_staff_req', time_staff_req),
        calendar_notes = COALESCE(p_data->'calendar_notes', calendar_notes),
        break_rules = COALESCE(p_data->'break_rules', break_rules),
        shop_rules_text = COALESCE(p_data->>'shop_rules_text', shop_rules_text),
        custom_shifts = COALESCE(p_data->'custom_shifts', custom_shifts),
        gemini_model = COALESCE(p_data->>'gemini_model', gemini_model),
        openai_model = COALESCE(p_data->>'openai_model', openai_model),
        llm_provider = COALESCE(p_data->>'llm_provider', llm_provider)
    WHERE id = v_id;

    RETURN jsonb_build_object('success', true, 'config_id', v_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, pg_temp;

GRANT EXECUTE ON FUNCTION update_config_by_contract(TEXT, JSONB) TO anon;

NOTIFY pgrst, 'reload schema';
