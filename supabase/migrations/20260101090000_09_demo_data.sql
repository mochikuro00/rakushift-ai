-- =========================================================
-- Rakushift AI: デモデータ再投入スクリプト (SaaS Full Edition)
-- =========================================================

-- デモテナントの作成は 01 が行う (contract_id='demo')。
-- ここは以前 create_tenant('demo','demo','...') を呼んでいたが、
-- 00/02/04 で create_tenant は「店名だけを受け取り契約IDを自動採番する」
-- 1引数版に置き換えられており、3引数版はもう存在しない。
-- そのままではファイル順に流したときに
--   ERROR: function create_tenant(unknown, unknown, unknown) does not exist
-- で落ちるため、01 が作ったデモテナントに追加データを入れる形にする。
-- (contract_id を指定できない現在の create_tenant では 'demo' を作れない)
DO $$
DECLARE
    v_org_id UUID;
BEGIN
    SELECT organization_id INTO v_org_id FROM config WHERE contract_id = 'demo';
    IF v_org_id IS NULL THEN
        RAISE NOTICE '[09] デモテナントが無いため追加データの投入をスキップします';
        RETURN;
    END IF;

    -- スタッフA
    INSERT INTO staff (
        organization_id, contract_id, login_id, password,
        name, role, evaluation, salary_type, hourly_wage
    )
    SELECT v_org_id, 'demo', 'staff', 'password',
           'スタッフA', 'staff', 'B', 'hourly', 1100
    WHERE NOT EXISTS (
        SELECT 1 FROM staff WHERE organization_id = v_org_id AND login_id = 'staff');

    -- スタッフB
    INSERT INTO staff (
        organization_id, contract_id, login_id, password,
        name, role, evaluation, salary_type, hourly_wage
    )
    SELECT v_org_id, 'demo', 'staff2', 'password',
           'スタッフB', 'staff', 'B', 'hourly', 1050
    WHERE NOT EXISTS (
        SELECT 1 FROM staff WHERE organization_id = v_org_id AND login_id = 'staff2');

    -- シフトデータ
    INSERT INTO shifts (organization_id, staff_id, date, start_time, end_time, break_minutes)
    SELECT 
        v_org_id, id, to_char(current_date, 'YYYY-MM-DD'), '09:00', '18:00', 60
    FROM staff WHERE contract_id = 'demo' LIMIT 1;

END $$;
