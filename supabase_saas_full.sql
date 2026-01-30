-- =========================================================
-- Rakushift AI: SaaS完全対応版スキーマ初期化スクリプト (Ultimate Edition)
-- SaaS機能: マルチテナント認証, AI監査設定, Stripe連携, 自動テナント発行
-- =========================================================

-- 1. クリーンアップ (依存関係も含めて完全に削除)
DROP TABLE IF EXISTS requests CASCADE;
DROP TABLE IF EXISTS shifts CASCADE;
DROP TABLE IF EXISTS staff CASCADE;
DROP TABLE IF EXISTS config CASCADE;
DROP TABLE IF EXISTS profiles CASCADE;
DROP TABLE IF EXISTS organizations CASCADE;
DROP FUNCTION IF EXISTS create_tenant CASCADE;
DROP FUNCTION IF EXISTS is_subscription_active CASCADE;
DROP FUNCTION IF EXISTS handle_new_user CASCADE;

-- 2. テーブル定義

CREATE TABLE organizations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Configテーブル: 契約の「核」となるテーブル
CREATE TABLE config (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    
    -- 【SaaS認証用】(ユニーク制約必須)
    contract_id TEXT UNIQUE NOT NULL, -- 契約ID (例: demo)
    shop_password TEXT NOT NULL,      -- 店舗パスワード
    
    -- 【Stripeサブスクリプション管理】
    stripe_customer_id TEXT,
    stripe_subscription_id TEXT,
    subscription_status TEXT DEFAULT 'active', 
    -- 'active': 利用可能
    -- 'past_due': 支払い失敗中（猶予期間・利用可能）
    -- 'unpaid': 支払い不能（利用停止）
    -- 'canceled': 解約済み（利用停止）
    
    -- 店舗基本設定
    admin_password TEXT DEFAULT '0000',
    opening_time TEXT DEFAULT '09:00',
    closing_time TEXT DEFAULT '22:00',
    hourly_wage_default INTEGER DEFAULT 1100,
    
    -- 詳細設定 (JSONB)
    opening_times JSONB DEFAULT '{"weekday":{"start":"09:00","end":"22:00"},"weekend":{"start":"10:00","end":"20:00"},"holiday":{"start":"10:00","end":"20:00"}}'::jsonb,
    closed_days INTEGER[] DEFAULT '{}',
    staff_req JSONB DEFAULT '{"min_manager":1,"min_weekday":2,"min_weekend":3,"min_holiday":3}'::jsonb,
    roles JSONB DEFAULT '[{"id":"manager","name":"店長","color":"purple","level":3},{"id":"leader","name":"リーダー","color":"blue","level":2},{"id":"staff","name":"スタッフ","color":"gray","level":1}]'::jsonb,
    special_holidays TEXT[] DEFAULT '{}',
    special_days JSONB DEFAULT '{}'::jsonb,
    time_staff_req JSONB DEFAULT '[]'::jsonb,
    calendar_notes JSONB DEFAULT '{}'::jsonb,
    break_rules JSONB DEFAULT '[{"min_hours":6,"break_minutes":45},{"min_hours":8,"break_minutes":60}]'::jsonb,
    shop_rules_text TEXT DEFAULT '',
    custom_shifts JSONB DEFAULT '[{"name":"早番","start":"09:00","end":"17:00"},{"name":"遅番","start":"17:00","end":"22:00"}]'::jsonb,
    
    -- AI監査設定
    openai_api_key TEXT,
    openai_model TEXT,
    gemini_api_key TEXT,
    gemini_model TEXT,
    llm_provider TEXT DEFAULT 'openai'
);

CREATE TABLE staff (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    
    -- 基本情報
    name TEXT NOT NULL,
    
    -- 【管理者ログイン用】
    contract_id TEXT NOT NULL, 
    login_id TEXT, -- スタッフの場合はNULL可（店舗ログインのみで使う場合）
    password TEXT, -- 同上
    
    -- 属性・評価
    role TEXT DEFAULT 'staff',
    evaluation TEXT DEFAULT 'B', -- A, B, C, D
    salary_type TEXT DEFAULT 'hourly', -- hourly / monthly
    
    -- 給与・休日
    hourly_wage INTEGER DEFAULT 1100,
    monthly_salary INTEGER DEFAULT 0,
    annual_holidays INTEGER DEFAULT 105,
    
    -- 勤務制約
    max_days_week INTEGER DEFAULT 5,
    max_hours_day INTEGER DEFAULT 8,
    unavailable_dates TEXT -- カンマ区切り
);

CREATE TABLE shifts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    staff_id UUID REFERENCES staff(id) ON DELETE CASCADE,
    
    -- シフトデータ
    date TEXT NOT NULL, -- YYYY-MM-DD
    start_time TEXT NOT NULL, -- HH:MM
    end_time TEXT NOT NULL, -- HH:MM
    break_minutes INTEGER DEFAULT 60
);

CREATE TABLE requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    staff_id UUID REFERENCES staff(id) ON DELETE CASCADE,
    
    -- 申請データ
    type TEXT NOT NULL, -- off / work
    dates TEXT NOT NULL,
    start_time TEXT,
    end_time TEXT,
    reason TEXT,
    status TEXT DEFAULT 'pending',
    created_at TIMESTAMPTZ DEFAULT now()
);

-- 3. セキュリティ設定 (RLS無効化 - アプリ層で制御)
ALTER TABLE organizations DISABLE ROW LEVEL SECURITY;
ALTER TABLE config DISABLE ROW LEVEL SECURITY;
ALTER TABLE staff DISABLE ROW LEVEL SECURITY;
ALTER TABLE shifts DISABLE ROW LEVEL SECURITY;
ALTER TABLE requests DISABLE ROW LEVEL SECURITY;

-- 4. インデックス作成 (パフォーマンス向上)
CREATE INDEX idx_config_contract_id ON config(contract_id);
CREATE INDEX idx_staff_contract_id ON staff(contract_id);
CREATE INDEX idx_shifts_date ON shifts(date);
CREATE INDEX idx_shifts_staff_id ON shifts(staff_id);

-- 5. 【SaaSコア機能】テナント作成関数
-- StripeのThanksページ等から呼び出して、新規契約を一発で構築する
CREATE OR REPLACE FUNCTION create_tenant(
    p_contract_id TEXT,
    p_shop_password TEXT,
    p_org_name TEXT
) RETURNS JSONB AS $$
DECLARE
    new_org_id UUID;
BEGIN
    -- ID重複チェック
    IF EXISTS (SELECT 1 FROM config WHERE contract_id = p_contract_id) THEN
        RETURN jsonb_build_object('status', 'error', 'message', 'Contract ID already exists');
    END IF;

    -- 1. 組織作成
    INSERT INTO organizations (name) VALUES (p_org_name) RETURNING id INTO new_org_id;

    -- 2. 設定(Config)作成
    INSERT INTO config (
        organization_id, contract_id, shop_password, subscription_status
    ) VALUES (
        new_org_id, p_contract_id, p_shop_password, 'active' -- 初期状態はactive
    );

    -- 3. 初期管理者アカウント作成 (Admin)
    INSERT INTO staff (
        organization_id, contract_id, login_id, password,
        name, role, evaluation, salary_type, monthly_salary
    ) VALUES (
        new_org_id, p_contract_id, 'admin', 'password',
        '管理者 (初期アカウント)', 'manager', 'A', 'monthly', 300000
    );

    RETURN jsonb_build_object(
        'status', 'success',
        'contract_id', p_contract_id,
        'organization_id', new_org_id
    );

EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('status', 'error', 'message', SQLERRM);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 6. 【SaaSコア機能】サブスク状態チェック関数
-- アプリ側でログイン時にこれを呼ぶことで、支払い滞納者のアクセスを遮断できる
CREATE OR REPLACE FUNCTION check_subscription_status(p_contract_id TEXT) 
RETURNS JSONB AS $$
DECLARE
    v_status TEXT;
BEGIN
    SELECT subscription_status INTO v_status 
    FROM config 
    WHERE contract_id = p_contract_id;
    
    IF v_status IS NULL THEN
        RETURN jsonb_build_object('status', 'error', 'message', 'Contract not found');
    END IF;

    -- 利用可能ステータス: active, trialing, past_due(再決済中)
    IF v_status IN ('active', 'trialing', 'past_due') THEN
        RETURN jsonb_build_object('allowed', true, 'status', v_status);
    ELSE
        -- unpaid, canceled は利用不可
        RETURN jsonb_build_object('allowed', false, 'status', v_status, 'message', 'Subscription is not active');
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 7. 完了通知
NOTIFY pgrst, 'reload schema';
