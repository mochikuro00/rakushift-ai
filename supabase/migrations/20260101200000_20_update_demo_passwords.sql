-- 20_update_demo_passwords.sql
-- ===========================================================
-- Migration: デモ用アカウントのパスワードをマニュアル（仕様書）に統一する
-- ===========================================================

DO $$
DECLARE
    v_demo_org_id UUID;
BEGIN
    -- 1. デモ用店舗のIDを取得
    SELECT id INTO v_demo_org_id FROM organizations WHERE contract_id = 'demo' LIMIT 1;

    -- デモ店舗が存在する場合、パスワードを仕様書の初期値(rakushift1234)に統一
    IF v_demo_org_id IS NOT NULL THEN
        UPDATE organizations
        SET 
            password = crypt('rakushift1234', gen_salt('bf')),
            admin_password = crypt('rakushift1234', gen_salt('bf'))
        WHERE id = v_demo_org_id;

        -- configテーブルにパスワードが残っている場合も念のため更新
        UPDATE config
        SET 
            shop_password = crypt('rakushift1234', gen_salt('bf')),
            admin_password = crypt('rakushift1234', gen_salt('bf'))
        WHERE organization_id = v_demo_org_id;

        RAISE NOTICE 'Demo passwords updated to rakushift1234 for org_id: %', v_demo_org_id;
    END IF;

    -- 2. 本部・統括（HQ）アカウントの確認と確実な設定
    INSERT INTO hq_admins (login_id, password) 
    VALUES ('hq_master', crypt('rakushift_hq', gen_salt('bf')))
    ON CONFLICT (login_id) DO UPDATE 
    SET password = crypt('rakushift_hq', gen_salt('bf'));

    RAISE NOTICE 'HQ admin password ensured for hq_master.';
END $$;
