-- =========================================================
-- 97_norm_payer_godo.sql   (v3.7.287)
--
-- 合同会社の振込名義が正規化されない不具合の修正。
--
-- norm_payer は先に濁点を清音へ寄せる (ド → ト) のに、
-- 法人格の略号を落とす正規表現が濁点付きの [カユド] を見ていた。
-- そのため「ﾄﾞ)モチクロ」は 'ト)モチクロ' のまま残り、
-- 登録名義「モチクロ」と一致せず毎回「要確認」に落ちていた。
-- =========================================================

CREATE OR REPLACE FUNCTION norm_payer(p TEXT)
RETURNS TEXT AS $$
DECLARE
    v TEXT;
BEGIN
    v := upper(COALESCE(p, ''));

    -- 半角カナ → 全角カナ (清音の対応表)
    v := translate(v,
         'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜｦﾝｧｨｩｪｫｯｬｭｮｰ',
         'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲンアイウエオツヤユヨー');

    -- 濁点・半濁点は清音へ寄せる。
    -- 半角カナは「文字＋濁点記号」の2文字で来るため、合成せずに落とす方が確実。
    v := translate(v,
         'ガギグゲゴザジズゼゾダヂヅデドバビブベボパピプペポヴ',
         'カキクケコサシスセソタチツテトハヒフヘホハヒフヘホウ');
    v := regexp_replace(v, '[ﾞﾟ゛゜]', '', 'g');

    -- 小書き文字を大書きへ (ｷﾔ と キャ を同一視)
    v := translate(v, 'ァィゥェォッャュョヮ', 'アイウエオツヤユヨワ');

    -- 法人格の表記ゆれを除去
    v := regexp_replace(v, '(カフシキカイシヤ|ユウケンカイシヤ|コウトウカイシヤ|株式会社|有限会社|合同会社)', '', 'g');
    -- ここに来る時点で濁点は落ちているので ド ではなく ト で見る (合同会社 = ﾄﾞ)
    v := regexp_replace(v, '[（(]?[カユト][)）]', '', 'g');

    -- 記号・空白をすべて落とす
    v := regexp_replace(v, '[[:space:]　\-ー―‐・.,''"()（）]', '', 'g');

    RETURN NULLIF(v, '');
END;
$$ LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog, public, pg_temp;

REVOKE EXECUTE ON FUNCTION norm_payer(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION norm_payer(TEXT) TO service_role;

NOTIFY pgrst, 'reload schema';
