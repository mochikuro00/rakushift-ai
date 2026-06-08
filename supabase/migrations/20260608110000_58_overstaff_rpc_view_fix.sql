-- 58_overstaff_rpc_view_fix.sql
-- ===========================================================
-- v3.7.95: migration 57 で追加した allow_overstaffing カラムが
--   update_config_by_contract RPC で更新されず、
--   config_safe view からも取得できない状態だったのを修正。
--   結果として UI でチェックを ON にして保存しても消えていた。
-- ===========================================================

-- 1. update_config_by_contract に allow_overstaffing を追加
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
        llm_provider = COALESCE(p_data->>'llm_provider', llm_provider),
        -- v3.7.95: 過剰配置許容トグル
        allow_overstaffing = CASE
            WHEN p_data ? 'allow_overstaffing' THEN (p_data->>'allow_overstaffing')::BOOLEAN
            ELSE allow_overstaffing
        END
    WHERE id = v_id;

    RETURN jsonb_build_object('success', true, 'config_id', v_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, pg_temp;

GRANT EXECUTE ON FUNCTION update_config_by_contract(TEXT, JSONB) TO anon;

-- 2. config_safe view を再作成して allow_overstaffing を含める
DROP VIEW IF EXISTS config_safe;
CREATE VIEW config_safe AS
SELECT
    c.id,
    c.organization_id,
    c.contract_id,
    c.stripe_customer_id,
    c.stripe_subscription_id,
    c.subscription_status,
    c.stripe_plan,
    c.trial_ends_at,
    c.subscription_current_period_end,
    c.opening_time,
    c.closing_time,
    c.hourly_wage_default,
    c.opening_times,
    c.closed_days,
    c.staff_req,
    c.roles,
    c.special_holidays,
    c.special_days,
    c.time_staff_req,
    c.calendar_notes,
    c.break_rules,
    c.shop_rules_text,
    c.custom_shifts,
    c.openai_model,
    c.gemini_model,
    c.llm_provider,
    c.customer_email,
    c.contact_name,
    c.phone,
    c.contact_phone,
    c.address,
    c.referrer_code,
    c.payment_failed_at,
    c.allow_overstaffing,  -- v3.7.95: 追加
    o.license_status,
    o.license_suspended_at
FROM config c
LEFT JOIN organizations o ON o.id = c.organization_id;

GRANT SELECT ON config_safe TO anon;

NOTIFY pgrst, 'reload schema';
