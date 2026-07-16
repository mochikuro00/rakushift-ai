-- =========================================================
-- 81_referrer_bank_account.sql
-- 目的: 紹介者に「振込口座」を登録できるようにする。
--       報酬の振込先を運営が把握するための欄。
-- =========================================================

ALTER TABLE referrers
    ADD COLUMN IF NOT EXISTS bank_account TEXT DEFAULT '';

COMMENT ON COLUMN referrers.bank_account IS '報酬の振込先口座 (銀行名・支店・種別・番号・名義)';

-- create_referrer に p_bank_account を追加 (既存引数は維持)
CREATE OR REPLACE FUNCTION create_referrer(
    p_name TEXT,
    p_code TEXT DEFAULT NULL,
    p_email TEXT DEFAULT '',
    p_phone TEXT DEFAULT '',
    p_commission_rate NUMERIC DEFAULT 30.00,
    p_commission_amount NUMERIC DEFAULT 0,
    p_commission_type TEXT DEFAULT 'percent',
    p_note TEXT DEFAULT '',
    p_bank_account TEXT DEFAULT ''
) RETURNS JSONB AS $$
DECLARE
    new_code TEXT;
    new_id UUID;
BEGIN
    IF p_code IS NULL OR p_code = '' THEN
        LOOP
            new_code := 'REF' || upper(substring(md5(random()::text || clock_timestamp()::text), 1, 8));
            EXIT WHEN NOT EXISTS (SELECT 1 FROM referrers WHERE code = new_code);
        END LOOP;
    ELSE
        new_code := upper(p_code);
        IF EXISTS (SELECT 1 FROM referrers WHERE code = new_code) THEN
            RETURN jsonb_build_object('success', false, 'message', 'このコードは既に使用されています');
        END IF;
    END IF;

    INSERT INTO referrers (code, name, email, phone, commission_rate, commission_amount, commission_type, note, bank_account)
    VALUES (new_code, p_name, p_email, p_phone, p_commission_rate, p_commission_amount, p_commission_type, p_note, p_bank_account)
    RETURNING id INTO new_id;

    RETURN jsonb_build_object('success', true, 'id', new_id, 'code', new_code, 'name', p_name);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- update_referrer に p_bank_account を追加
CREATE OR REPLACE FUNCTION update_referrer(
    p_id UUID,
    p_name TEXT DEFAULT NULL,
    p_email TEXT DEFAULT NULL,
    p_phone TEXT DEFAULT NULL,
    p_commission_rate NUMERIC DEFAULT NULL,
    p_commission_amount NUMERIC DEFAULT NULL,
    p_commission_type TEXT DEFAULT NULL,
    p_active BOOLEAN DEFAULT NULL,
    p_note TEXT DEFAULT NULL,
    p_bank_account TEXT DEFAULT NULL
) RETURNS JSONB AS $$
BEGIN
    UPDATE referrers
    SET name = COALESCE(p_name, name),
        email = COALESCE(p_email, email),
        phone = COALESCE(p_phone, phone),
        commission_rate = COALESCE(p_commission_rate, commission_rate),
        commission_amount = COALESCE(p_commission_amount, commission_amount),
        commission_type = COALESCE(p_commission_type, commission_type),
        active = COALESCE(p_active, active),
        note = COALESCE(p_note, note),
        bank_account = COALESCE(p_bank_account, bank_account),
        updated_at = now()
    WHERE id = p_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'message', '紹介者が見つかりません');
    END IF;

    RETURN jsonb_build_object('success', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION create_referrer(TEXT,TEXT,TEXT,TEXT,NUMERIC,NUMERIC,TEXT,TEXT,TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION update_referrer(UUID,TEXT,TEXT,TEXT,NUMERIC,NUMERIC,TEXT,BOOLEAN,TEXT,TEXT) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
