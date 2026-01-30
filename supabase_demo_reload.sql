-- =========================================================
-- Rakushift AI: デモデータ再投入スクリプト (SaaS Full Edition)
-- =========================================================

-- 既存のdemoデータをクリーンアップ（念のため）
DELETE FROM organizations WHERE id IN (SELECT organization_id FROM config WHERE contract_id = 'demo');

-- create_tenant関数を使って、正規のフローでデモ環境を構築
-- これにより、関数自体の動作テストも兼ねる
SELECT create_tenant('demo', 'demo', 'Rakushift Demo Shop');

-- 追加のスタッフデータを投入 (Adminはcreate_tenantで作られているのでスキップ)
DO $$
DECLARE
    v_org_id UUID;
BEGIN
    SELECT organization_id INTO v_org_id FROM config WHERE contract_id = 'demo';

    -- スタッフA
    INSERT INTO staff (
        organization_id, contract_id, login_id, password,
        name, role, evaluation, salary_type, hourly_wage
    ) VALUES (
        v_org_id, 'demo', 'staff', 'password',
        'スタッフA', 'staff', 'B', 'hourly', 1100
    );

    -- スタッフB
    INSERT INTO staff (
        organization_id, contract_id, login_id, password,
        name, role, evaluation, salary_type, hourly_wage
    ) VALUES (
        v_org_id, 'demo', 'staff2', 'password',
        'スタッフB', 'staff', 'B', 'hourly', 1050
    );
    
    -- シフトデータ
    INSERT INTO shifts (organization_id, staff_id, date, start_time, end_time, break_minutes)
    SELECT 
        v_org_id, id, to_char(current_date, 'YYYY-MM-DD'), '09:00', '18:00', 60
    FROM staff WHERE contract_id = 'demo' LIMIT 1;

END $$;
