// =================================================================
// Rakushift AI: ステージング環境用設定テンプレート (v3.7.131)
//
// 使い方:
//   1. このファイルを js/config.js にコピーして本番値を上書き
//      ※ ただし本番 config.js は .gitignore 除外なので別管理推奨
//   2. もしくは Cloudflare Pages の Preview Build 環境変数で
//      STAGING_SUPABASE_URL / STAGING_SUPABASE_ANON_KEY を設定し、
//      build 時に config.js を自動生成
//
// 自動切替: index.html で host 名 (staging-*, *.pages.dev の preview URL)
//           を検出して STAGING_CONFIG を採用する仕組みを有効化
// =================================================================

const RAKUSHIFT_STAGING_CONFIG = {
    // ステージング Supabase (本番とは別プロジェクト)
    SUPABASE_URL: "https://YOUR_STAGING_PROJECT.supabase.co",
    SUPABASE_ANON_KEY: "eyJ...",  // ステージング用 anon key

    // ステージング Railway (本番とは別サービス)
    CALC_SERVER_URL: "https://rakushift-ai-staging.up.railway.app",

    // 環境識別 (UI に「STAGING」バナー表示)
    ENV_NAME: "staging",
    BANNER_COLOR: "#f59e0b",  // amber-500
};
