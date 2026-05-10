-- ===========================================================
-- Migration: パスワード変更・CSV出力サポート
-- ===========================================================

-- 店舗パスワード変更RPC (bcryptハッシュ対応)
CREATE OR REPLACE FUNCTION update_shop_password(
    p_contract_id TEXT,
    p_new_password TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    -- organizationsテーブルのパスワードハッシュを更新
    UPDATE organizations
    SET shop_password_hash = crypt(p_new_password, gen_salt('bf'))
    WHERE contract_id = p_contract_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Contract ID not found: %', p_contract_id;
    END IF;
END;
$$;

-- update_shop_passwordへのanon実行権限
GRANT EXECUTE ON FUNCTION update_shop_password(TEXT, TEXT) TO anon;
GRANT EXECUTE ON FUNCTION update_shop_password(TEXT, TEXT) TO authenticated;
