// =================================================================
// Rakushift AI: 環境設定テンプレート
// このファイルを config.js にコピーして値を入力してください
// config.js は .gitignore で除外されています
// =================================================================
//
// インフラ構成:
//   フロントエンド: Cloudflare Pages (GitHub自動デプロイ)
//   バックエンド:   Railway (Python / FastAPI / Docker)
//   データベース:   Supabase (PostgreSQL + RLS)
//   決済:           Stripe (サブスクリプション)
// =================================================================

const RAKUSHIFT_CONFIG = {
    // Supabase (Dashboard -> Settings -> API -> anon public key)
    SUPABASE_URL: "https://your-project.supabase.co",
    SUPABASE_ANON_KEY: "eyJ...",

    // Python計算サーバー (Railway URL)
    // 例: "https://rakushift-ai-production.up.railway.app"
    CALC_SERVER_URL: "https://YOUR_RAILWAY_URL.up.railway.app",
};
