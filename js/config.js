const RAKUSHIFT_CONFIG = {
    SUPABASE_URL: "https://guuocjilvtmppbqvsxtl.supabase.co",
    SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imd1dW9jamlsdnRtcHBicXZzeHRsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY4NTI5MzUsImV4cCI6MjA4MjQyODkzNX0.Myxf-cuIeQ9nzRRJ_Ti1rRlaZ53tmHb0eosEUMFwsHY",
    // 本番環境: Railway
    CALC_SERVER_URL: "https://rakushift-ai-production.up.railway.app",
    // v3.7.131: 本番では DEBUG=false で console.log を抑制 (情報漏洩防止)
    // ローカル開発時は ?debug=1 を URL に付けるか、true に書き換える
    DEBUG: false,
};

// v3.7.131: console 抑制 (DEBUG=false かつ ?debug=1 が無い場合)
// console.warn / console.error は本番でも残す (本当のエラーは捕捉したい)
(function() {
    const params = new URLSearchParams(location.search);
    const isDebug = RAKUSHIFT_CONFIG.DEBUG || params.has('debug');
    if (!isDebug) {
        const noop = function() {};
        console.log = noop;
        console.info = noop;
        console.debug = noop;
        // console.warn と console.error は本番でも残す
    }
})();
