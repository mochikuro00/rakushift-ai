-- =========================================================
-- Rakushift AI: デモデータ拡張スクリプト (スタッフ15名追加)
-- =========================================================

DO $$
DECLARE
    v_org_id UUID;
    v_contract_id TEXT := 'demo';
BEGIN
    -- 1. 組織IDの取得 (なければエラー)
    SELECT organization_id INTO v_org_id FROM config WHERE contract_id = v_contract_id;
    IF v_org_id IS NULL THEN
        RAISE EXCEPTION 'Demo organization not found.';
    END IF;

    -- 2. スタッフ一括投入 (15名)
    -- 様々な役割、評価、給与形態をミックス
    INSERT INTO staff (organization_id, contract_id, name, role, evaluation, salary_type, hourly_wage, monthly_salary, max_days_week, max_hours_day)
    VALUES
    (v_org_id, v_contract_id, '佐藤 健 (店長)', 'manager', 'A', 'monthly', 0, 320000, 5, 8),
    (v_org_id, v_contract_id, '鈴木 一郎 (副店長)', 'manager', 'A', 'monthly', 0, 280000, 5, 8),
    (v_org_id, v_contract_id, '高橋 花子 (リーダー)', 'leader', 'A', 'hourly', 1300, 0, 5, 8),
    (v_org_id, v_contract_id, '田中 太郎', 'staff', 'B', 'hourly', 1100, 0, 5, 8),
    (v_org_id, v_contract_id, '伊藤 次郎', 'staff', 'B', 'hourly', 1100, 0, 4, 6),
    (v_org_id, v_contract_id, '渡辺 三郎', 'staff', 'C', 'hourly', 1050, 0, 3, 5),
    (v_org_id, v_contract_id, '山本 シロー', 'staff', 'C', 'hourly', 1050, 0, 3, 5),
    (v_org_id, v_contract_id, '中村 ゴロー', 'staff', 'D', 'hourly', 1000, 0, 2, 4),
    (v_org_id, v_contract_id, '小林 ロクロ', 'staff', 'B', 'hourly', 1100, 0, 5, 8),
    (v_org_id, v_contract_id, '加藤 ナナ', 'staff', 'B', 'hourly', 1100, 0, 4, 7),
    (v_org_id, v_contract_id, '吉田 ハチ', 'staff', 'A', 'hourly', 1200, 0, 5, 8),
    (v_org_id, v_contract_id, '山田 キュー', 'staff', 'C', 'hourly', 1050, 0, 3, 6),
    (v_org_id, v_contract_id, '佐々木 ジュウ', 'staff', 'D', 'hourly', 1000, 0, 2, 4),
    (v_org_id, v_contract_id, '山口 イチイチ', 'staff', 'B', 'hourly', 1100, 0, 4, 8),
    (v_org_id, v_contract_id, '松本 ジュウニ', 'staff', 'B', 'hourly', 1100, 0, 5, 8);

    -- 3. 設定データの更新 (よりリアルな設定に)
    UPDATE config
    SET 
        staff_req = '{"min_manager":1,"min_weekday":3,"min_weekend":5,"min_holiday":5}'::jsonb,
        custom_shifts = '[
            {"name":"早番","start":"09:00","end":"18:00"},
            {"name":"遅番","start":"13:00","end":"22:00"},
            {"name":"中番","start":"11:00","end":"20:00"}
        ]'::jsonb,
        opening_times = '{"weekday":{"start":"09:00","end":"22:00"},"weekend":{"start":"09:00","end":"23:00"},"holiday":{"start":"09:00","end":"23:00"}}'::jsonb
    WHERE contract_id = v_contract_id;

END $$;
