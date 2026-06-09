# ステージング環境 構築手順書 (v3.7.131)

> **目的**: 本番に影響しない別環境で セキュリティ強化・新機能を検証する
> **構成**: 本番と同じ 3 層 (Cloudflare Pages / Railway / Supabase) を別プロジェクトで構築
> **想定時間**: 初回 60-90分 / 以降の更新は 10-15分

---

## 全体アーキテクチャ

```
┌─────────────────────────────────────────────────────────────┐
│ 本番 (production)                                            │
│ ─────────────────────────────────────────────────────────── │
│ Frontend  https://rakushift-ai.pages.dev/                   │
│ Backend   https://rakushift-ai-production.up.railway.app/   │
│ DB        https://guuocjilvtmppbqvsxtl.supabase.co/         │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ ステージング (staging) - 新規構築                            │
│ ─────────────────────────────────────────────────────────── │
│ Frontend  https://staging.rakushift-ai.pages.dev/  ← 自動   │
│ Backend   https://rakushift-ai-staging.up.railway.app/      │
│ DB        https://YOUR_STAGING_PROJECT.supabase.co/         │
└─────────────────────────────────────────────────────────────┘
```

---

## Step 1: Supabase ステージングプロジェクト作成 (手動)

### 1-1. 新規プロジェクト作成

1. https://supabase.com/dashboard にログイン
2. 「New project」をクリック
3. 以下を入力:
   - **Name**: `rakushift-ai-staging`
   - **Database Password**: 強力なパスワード (メモ必須)
   - **Region**: `Northeast Asia (Tokyo)` (本番と同じ)
   - **Plan**: Free (検証用なので無料枠で十分)
4. 「Create new project」をクリック → 約 2 分で完成

### 1-2. API キー取得

1. Settings → API
2. 以下をメモ:
   - **Project URL**: `https://xxxxxxx.supabase.co` (= `STAGING_SUPABASE_URL`)
   - **anon (public) key**: `eyJ...` (= `STAGING_SUPABASE_ANON_KEY`)
   - **service_role (secret) key**: `eyJ...` (= `STAGING_SUPABASE_SERVICE_KEY`)

### 1-3. マイグレーション一括実行

ローカル PowerShell で:

```powershell
cd C:\Users\user\Desktop\システム開発\rakushift-ai-main
$env:SUPABASE_URL = "https://YOUR_STAGING_PROJECT.supabase.co"
$env:SUPABASE_SERVICE_KEY = "eyJ...service_role_key..."
.\scripts\setup_staging_db.ps1
```

→ `supabase/migrations/*.sql` 57本を順次実行 (約 5 分)

---

## Step 2: Railway ステージングサービス作成 (手動)

### 2-1. 新規サービス追加

1. https://railway.com/dashboard で本番プロジェクトを開く
2. 「+ New」→「GitHub Repo」→ `rakushift-ai` を選択
3. Service 名: `rakushift-ai-staging`
4. Settings → Service Source → Branch: `staging` を選択 (後述のブランチ作成後)

### 2-2. 環境変数 設定

Railway Service の Variables タブで以下を追加:

| Key | Value |
|---|---|
| `SUPABASE_URL` | (Step 1-2 の Project URL) |
| `SUPABASE_SERVICE_KEY` | (Step 1-2 の service_role key) |
| `SUPABASE_ANON_KEY` | (Step 1-2 の anon key) |
| `ENV_NAME` | `staging` |
| `INQUIRY_EMAIL_TO` | (テスト用メアド) |
| `SMTP_USER` / `SMTP_PASS` | (テスト用) |
| `STRIPE_SECRET_KEY` | (Stripe テストモード `sk_test_...`) |
| `STRIPE_WEBHOOK_SECRET` | (Stripe テストモード webhook) |

### 2-3. デプロイ URL を取得

- Settings → Networking → Generate Domain
- 取得した URL (例: `https://rakushift-ai-staging.up.railway.app`) をメモ

---

## Step 3: フロント (Cloudflare Pages) のステージング設定

### 3-1. ローカルで `staging` ブランチ作成

```powershell
cd C:\Users\user\Desktop\システム開発\rakushift-ai-main
git checkout -b staging
git push -u origin staging
```

→ Cloudflare Pages が **Preview Deployment** として自動配信:
   `https://staging.rakushift-ai.pages.dev` (= **STAGING URL**)

### 3-2. `js/config.staging.js` を作成

```powershell
cp js/config.staging.example.js js/config.staging.js
# 編集して以下を入力:
# - SUPABASE_URL: Step 1-2 で取得
# - SUPABASE_ANON_KEY: 同上
# - CALC_SERVER_URL: Step 2-3 で取得
git add js/config.staging.js
git commit -m "chore(staging): add staging config"
git push origin staging
```

> `config.staging.js` は `.gitignore` で除外推奨 (実 key を含むため)
> 必要なら Cloudflare Pages の Build 環境変数で生成

### 3-3. ステージング URL アクセス

ブラウザで `https://staging.rakushift-ai.pages.dev` を開く:
- 画面上部に **「⚠ STAGING ENV ⚠」** バナーが表示される (黄色帯)
- ログインモーダルに「ステージング」表記
- 本番 DB ではなくステージング DB に接続

---

## Step 4: テナント・スタッフ データ投入

ステージング DB は空なので、テスト用テナント・スタッフを投入:

```powershell
.\scripts\seed_staging.ps1
```

→ 以下が作成される:
- テストテナント (contract_id: `STAGING-TEST-001`)
- 管理者アカウント (パスワード: `staging123`)
- サンプルスタッフ 10名
- サンプルシフトパターン 3種

---

## Step 5: 動作確認 (検証チェックリスト)

`docs/STAGING_VERIFICATION.md` のチェックリストに従って、3画面 × 主要機能を検証。

---

## 運用フロー (本番にマージする前の検証)

```
1. main で開発・テスト
2. staging にマージ → Cloudflare Preview 自動デプロイ
3. ステージング URL で手動検証 + Playwright E2E
4. 問題なければ main にマージ → 本番自動デプロイ
```

---

## トラブルシューティング

### Q1. ステージング URL でも本番 config が使われる
- `index.html` の host 判定ロジックを確認 (v3.7.131)
- 実 host 名が `staging.` で始まるか、または `.pages.dev` に preview が含まれるか

### Q2. マイグレーション実行失敗
- `setup_staging_db.ps1` のログを確認
- `SUPABASE_SERVICE_KEY` が service_role か (anon ではない)
- 失敗した migration の SQL を Supabase Dashboard SQL Editor で手動実行

### Q3. Railway デプロイ失敗
- Build Logs を確認
- 環境変数 `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` が設定されているか
- `python/requirements.txt` の依存が解決可能か

### Q4. Cloudflare Pages Preview が作られない
- `staging` ブランチが正しく push されているか
- Settings → Builds → Preview deployments が enable か
- Branch deploy rules で `staging` が許可されているか

---

## コスト試算

| サービス | プラン | 月額 |
|---|---|---|
| Cloudflare Pages | Free (Unlimited bandwidth) | 0円 |
| Railway | Hobby ($5/月) | ~750円 |
| Supabase | Free (500MB DB) | 0円 |
| **合計** | | **~750円/月** |

> 検証期間中のみ Railway 課金、不要時は Pause 可能

---

## 削除手順 (検証完了後)

1. Cloudflare Pages: `staging` branch deploy を Disable
2. Railway: `rakushift-ai-staging` サービスを Delete
3. Supabase: ステージングプロジェクトを Settings → General → Delete project
4. git: `git push origin --delete staging`

---

最終更新: 2026-06-10 (v3.7.131)
