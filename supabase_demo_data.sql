-- =========================================================
-- Rakushift AI: デモデータ投入スクリプト (SaaS Demo)
-- =========================================================

DO $$
DECLARE
    new_org_id UUID;
    staff_admin_id UUID;
    staff_1_id UUID;
    staff_2_id UUID;
BEGIN
    -- 1. 組織作成 (Organization)
    INSERT INTO organizations (name) VALUES ('Demo Shop') RETURNING id INTO new_org_id;

    -- 2. 設定作成 (Config) - 契約IDとパスワードを設定
    INSERT INTO config (
        organization_id, contract_id, shop_password, 
        admin_password, opening_time, closing_time,
        roles, staff_req, time_staff_req
    ) VALUES (
        new_org_id, 'demo', 'demo',
        '0000', '09:00', '22:00',
        '[{"id":"manager","name":"店長","color":"purple","level":3},{"id":"leader","name":"リーダー","color":"blue","level":2},{"id":"staff","name":"スタッフ","color":"gray","level":1}]'::jsonb,
        '{"min_manager":1,"min_weekday":2,"min_weekend":3,"min_holiday":3}'::jsonb,
        '[{"days":[1,2,3,4,5],"start":"11:00","end":"14:00","count":3}]'::jsonb
    );

    -- 3. スタッフ作成 (Staff)
    
    -- 店長 (Admin)
    INSERT INTO staff (
        organization_id, contract_id, login_id, password,
        name, role, evaluation, salary_type, monthly_salary, max_days_week, max_hours_day
    ) VALUES (
        new_org_id, 'demo', 'admin', 'password',
        '店長 (管理者)', 'manager', 'A', 'monthly', 300000, 5, 8
    ) RETURNING id INTO staff_admin_id;

    -- スタッフA
    INSERT INTO staff (
        organization_id, contract_id, login_id, password,
        name, role, evaluation, salary_type, hourly_wage, max_days_week, max_hours_day
    ) VALUES (
        new_org_id, 'demo', 'staff', 'password',
        'スタッフA', 'staff', 'B', 'hourly', 1100, 5, 8
    ) RETURNING id INTO staff_1_id;

    -- スタッフB
    INSERT INTO staff (
        organization_id, contract_id, login_id, password,
        name, role, evaluation, salary_type, hourly_wage, max_days_week, max_hours_day
    ) VALUES (
        new_org_id, 'demo', 'staff2', 'password',
        'スタッフB', 'staff', 'B', 'hourly', 1050, 4, 6
    ) RETURNING id INTO staff_2_id;

    -- 4. シフトデータ (Shifts) - 直近の日付でいくつか
    INSERT INTO shifts (organization_id, staff_id, date, start_time, end_time, break_minutes)
    VALUES 
        (new_org_id, staff_admin_id, to_char(current_date, 'YYYY-MM-DD'), '09:00', '18:00', 60),
        (new_org_id, staff_1_id, to_char(current_date, 'YYYY-MM-DD'), '10:00', '19:00', 60),
        (new_org_id, staff_2_id, to_char(current_date + interval '1 day', 'YYYY-MM-DD'), '11:00', '17:00', 45);

END $$;
