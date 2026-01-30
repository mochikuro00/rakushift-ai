-- =========================================================
-- Rakushift AI: SaaS対応版スキーマ初期化スクリプト
-- =========================================================

-- 1. 既存のすべてを削除 (CASCADEで関連データも道連れにする)
DROP TABLE IF EXISTS requests CASCADE;
DROP TABLE IF EXISTS shifts CASCADE;
DROP TABLE IF EXISTS staff CASCADE;
DROP TABLE IF EXISTS config CASCADE;
DROP TABLE IF EXISTS profiles CASCADE;
DROP TABLE IF EXISTS organizations CASCADE;
DROP FUNCTION IF EXISTS get_my_org_id CASCADE;
DROP FUNCTION IF EXISTS handle_new_user CASCADE;

-- 2. テーブルをシンプルに再作成 (SaaS対応カラム追加)

CREATE TABLE organizations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL
);

CREATE TABLE profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id),
    organization_id UUID REFERENCES organizations(id),
    role TEXT DEFAULT 'admin',
    name TEXT
);

CREATE TABLE config (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID REFERENCES organizations(id),
    -- SaaS認証用 (重要)
    contract_id TEXT, -- 契約ID
    shop_password TEXT, -- 店舗パスワード
    -- 設定項目
    admin_password TEXT DEFAULT '0000',
    opening_time TEXT DEFAULT '09:00',
    closing_time TEXT DEFAULT '22:00',
    hourly_wage_default INTEGER DEFAULT 1100,
    opening_times JSONB DEFAULT '{}'::jsonb,
    closed_days INTEGER[] DEFAULT '{}',
    staff_req JSONB DEFAULT '{}'::jsonb,
    roles JSONB DEFAULT '[]'::jsonb,
    special_holidays TEXT[] DEFAULT '{}',
    special_days JSONB DEFAULT '{}'::jsonb,
    time_staff_req JSONB DEFAULT '[]'::jsonb,
    calendar_notes JSONB DEFAULT '{}'::jsonb,
    break_rules JSONB DEFAULT '[]'::jsonb,
    shop_rules_text TEXT DEFAULT '',
    custom_shifts JSONB DEFAULT '[]'::jsonb,
    -- AI設定
    openai_api_key TEXT,
    openai_model TEXT,
    gemini_api_key TEXT,
    gemini_model TEXT,
    llm_provider TEXT DEFAULT 'openai'
);

CREATE TABLE staff (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID REFERENCES organizations(id),
    name TEXT NOT NULL,
    -- 認証用 (重要)
    contract_id TEXT, 
    login_id TEXT,
    password TEXT,
    -- プロフィール
    role TEXT DEFAULT 'staff',
    evaluation TEXT DEFAULT 'B',
    salary_type TEXT DEFAULT 'hourly',
    hourly_wage INTEGER DEFAULT 1100,
    monthly_salary INTEGER DEFAULT 0,
    max_days_week INTEGER DEFAULT 5,
    max_hours_day INTEGER DEFAULT 8,
    unavailable_dates TEXT, -- カンマ区切り
    annual_holidays INTEGER DEFAULT 105
);

CREATE TABLE shifts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID REFERENCES organizations(id),
    staff_id UUID REFERENCES staff(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    break_minutes INTEGER DEFAULT 60
);

CREATE TABLE requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID REFERENCES organizations(id),
    staff_id UUID REFERENCES staff(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    dates TEXT NOT NULL,
    start_time TEXT,
    end_time TEXT,
    reason TEXT,
    status TEXT DEFAULT 'pending',
    created_at TIMESTAMPTZ DEFAULT now()
);

-- 3. セキュリティ(RLS)の完全無効化
ALTER TABLE organizations DISABLE ROW LEVEL SECURITY;
ALTER TABLE profiles DISABLE ROW LEVEL SECURITY;
ALTER TABLE config DISABLE ROW LEVEL SECURITY;
ALTER TABLE staff DISABLE ROW LEVEL SECURITY;
ALTER TABLE shifts DISABLE ROW LEVEL SECURITY;
ALTER TABLE requests DISABLE ROW LEVEL SECURITY;

-- 4. 自動化トリガー (新規登録時に組織を作る)
CREATE OR REPLACE FUNCTION public.handle_new_user() 
RETURNS TRIGGER AS $$
DECLARE
  new_org_id UUID;
BEGIN
  INSERT INTO public.organizations (name) VALUES ('My Shop') RETURNING id INTO new_org_id;
  INSERT INTO public.profiles (id, organization_id, role, name) VALUES (new.id, new_org_id, 'admin', 'Admin');
  INSERT INTO public.config (organization_id) VALUES (new_org_id);
  RETURN new;
END;

$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE PROCEDURE public.handle_new_user();

-- 5. キャッシュリセット
NOTIFY pgrst, 'reload schema';
