# デプロイ運用手順書

最終更新: 2026-05-22

## 1. 構成

| レイヤ | サービス | デプロイ方式 |
|---|---|---|
| Frontend | Cloudflare Pages | GitHub `main` push で自動 |
| Backend | Railway (Docker) | GitHub `main` push で自動 (`python/**` 監視) |
| Database | Supabase (PostgreSQL) | Supabase CLI または Studio 手動 |
| 決済 | Stripe | Stripe Dashboard |

---

## 2. 初回セットアップ

### 2.1 GitHub Secrets
リポジトリ Settings → Secrets and variables → Actions:

| Secret | 用途 | 取得元 |
|---|---|---|
| `SUPABASE_ACCESS_TOKEN` | Supabase CLI 認証 | https://supabase.com/dashboard/account/tokens |
| `SUPABASE_DB_PASSWORD` | `supabase db push` 実行 | Supabase Studio → Project Settings → Database |
| `SUPABASE_PROJECT_REF` | (任意) project ref | デフォルト `guuocjilvtmppbqvsxtl` |
| `SLACK_WEBHOOK_URL` | (任意) 失敗通知 | Slack の Incoming Webhook |

### 2.2 Railway 環境変数
Railway dashboard → Variables:

#### Supabase / システム基盤
| 変数 | 必須 | 説明 |
|---|---|---|
| `SUPABASE_URL` | ✅ | `https://guuocjilvtmppbqvsxtl.supabase.co` |
| `SUPABASE_SERVICE_KEY` | ✅ | Supabase Service Role Key (RLS バイパス用) |
| `FRONTEND_URL` | ✅ | `https://rakushift-ai.pages.dev` |
| `ALLOWED_ORIGINS` | ⚠ | CSV で本番フロントを限定 (省略時はデフォルトリスト) |
| `ADMIN_API_TOKEN` | ✅ | `/admin/send-welcome-email` `/hq/shops` 等の管理API認証 |
| `MIGRATION_TOKEN` | ✅ | `/run-migration` エンドポイント保護 |
| `IS_PRODUCTION` | ✅ | `1` (例外メッセージマスク有効) |
| `RAILWAY_ENVIRONMENT` | 自動 | Railway が自動付与 (`production` で logger INFO 以上) |
| `PORT` | 自動 | Railway 注入 |

#### SMTP (ウェルカム/問い合わせメール送信)
※ DB `platform_settings` 経由でも設定可能。両方未設定だとメール機能スキップ。
| 変数 | 必須 | 例 |
|---|---|---|
| `SMTP_HOST` | ⚠ | `smtp.gmail.com` |
| `SMTP_PORT` | ⚠ | `587` |
| `SMTP_USER` | ⚠ | `noreply@example.com` |
| `SMTP_PASS` | ⚠ | アプリパスワード (Gmail なら 16文字) |
| `SMTP_FROM` | △ | 省略時 `SMTP_USER` を使用 |
| `INQUIRY_EMAIL_TO` | ⚠ | 法人お問い合わせ通知先 (営業窓口メール) |

#### AI / 決済 (DB `platform_settings` 推奨。環境変数でも上書き可)
| 設定キー (platform_settings) | 同等の環境変数 | 説明 |
|---|---|---|
| `stripe_secret_key` | `STRIPE_SECRET_KEY` | `sk_live_...` |
| `stripe_webhook_secret` | `STRIPE_WEBHOOK_SECRET` | `whsec_...` (Stripe Dashboard → Webhooks) |
| `stripe_price_standard` / `_pro` / `_premium` | 同名 | Stripe Price ID |
| `gemini_api_key` | `GEMINI_API_KEY` | Google AI Studio |
| `gemini_model` | `GEMINI_MODEL` | `gemini-2.0-flash` (推奨) |
| `openai_api_key` (現在未使用) | `OPENAI_API_KEY` | 将来用 |
| `llm_provider` | `LLM_PROVIDER` | `gemini` (デフォルト) |

#### 設定方法
```sql
-- 例: Stripe Webhook Secret を本番 DB に保存
UPDATE platform_settings SET value = 'whsec_xxx' WHERE key = 'stripe_webhook_secret';
-- または RPC 経由
SELECT update_platform_setting('stripe_webhook_secret', 'whsec_xxx');
```

> ℹ️ Railway 環境変数と DB の `platform_settings` 両方に値がある場合、`_get_setting()` は **DB を優先**。環境変数はフォールバック。

### 2.3 Cloudflare Pages
- Build command: なし
- Output: `/` (リポジトリルート)
- Custom domain 設定後、`https://<domain>` を `ALLOWED_ORIGINS` にも追加

---

## 3. デプロイフロー

### 3.1 通常変更 (フロント / バックエンド)
```bash
# フロントを変更した場合: スーパーリロード不要にするため ?v= バージョン更新
pwsh scripts/bump-version.ps1

# その後 commit & push
git add .
git commit -m "feat: 機能追加 + bump asset version"
git push origin main
# → Cloudflare Pages と Railway が自動 deploy
```

#### キャッシュ戦略 (お客様端末のブラウザキャッシュ対策)
ラクシフトAI は **お客様がスーパーリロード (Ctrl+F5) しなくても新版が反映される** 設計です。

| ファイル | キャッシュ戦略 |
|---|---|
| `index.html` / `admin.html` | `Cache-Control: no-cache` ([_headers](../_headers) で設定) → 毎アクセスで最新HTML取得 |
| `js/*.js` | HTMLの `<script src="js/xxx.js?v=YYYYMMDD">` 経由でキャッシュ破棄。`?v=` 値が変わると別ファイル扱いで新版取得 |
| `images/*` | 1日キャッシュ (変更頻度低) |
| `privacy.html` | 1日キャッシュ |

→ **JS/HTML を変更したら必ず `scripts/bump-version.ps1` を実行してから push** すること。

これにより:
- 既存ログイン中の顧客 → 次回ページ遷移 or リロードで自動的に新版取得
- ブラウザを開きっぱなしの顧客 → 24時間以内のリロードで新版取得 (HTML の no-cache + JS の短期キャッシュ)

### 3.2 DB マイグレーション
```bash
# 方法A: GitHub Actions (推奨)
# supabase/migrations/ 配下にファイル追加して push
# → .github/workflows/supabase_migrate.yml が自動実行

# 方法B: ローカル CLI
SUPABASE_ACCESS_TOKEN=sbp_xxx npx supabase link --project-ref guuocjilvtmppbqvsxtl
SUPABASE_ACCESS_TOKEN=sbp_xxx npx supabase db push

# 方法C: Studio で手動 (緊急時)
# https://supabase.com/dashboard/project/guuocjilvtmppbqvsxtl/sql/new
# → 該当SQLを貼り付けて Run
```

### 3.2.1 セキュリティハードニング v1 で追加実行すべき SQL
2026-05-22 のハードニング後、migration ファイル外で追加実行すべき GRANT/REVOKE/ALTER が存在する。
詳細は [CHANGELOG_SECURITY.md](CHANGELOG_SECURITY.md) の各「本番DBに追加で適用すべきSQL」セクションを参照。
本番 (`guuocjilvtmppbqvsxtl`) には適用済み。新規セットアップ環境では必ず実行すること。

### 3.3 ロールバック
- フロント/バックエンド: GitHub で revert commit → push
- DB マイグレーション: **そのままロールバック不可**。逆操作の `_fix.sql` を新規作成して push

---

## 4. ヘルスチェック

| エンドポイント | 目的 | 期待値 |
|---|---|---|
| `https://<railway>/health` | Railway healthcheck (DB疎通含む) | `{"status":"ok","db":"alive"}` |
| `https://<railway>/keepalive` | Supabase keep-alive (GitHub Actions 経由) | `{"status":"ok","db":"alive"}` |
| `https://<railway>/` | 簡易疎通 | `{"status":"ok",...}` |

`/health` 障害時:
1. Railway logs で例外確認
2. Supabase Studio → Database → Health 確認
3. Service Key 期限切れチェック

---

## 5. 監視

### 5.1 Supabase Security Advisor
週1で確認:
- Dashboard → Database → Advisors
- `rls_disabled_in_public` 警告ゼロ維持

### 5.2 ログ確認
```sql
-- 直近24時間のエラー
SELECT occurred_at, function_name, sql_state, sql_errm
FROM rpc_error_log
WHERE occurred_at > now() - interval '24 hours'
ORDER BY occurred_at DESC;

-- ロック中のログイン試行
SELECT identifier, failed_count, locked_until
FROM login_attempts
WHERE locked_until > now();
```

### 5.3 Stripe Webhook
Stripe Dashboard → Developers → Webhooks → 該当エンドポイント → Events
- `checkout.session.completed` で 200 が返っていること
- リトライが連続発生していないこと

---

## 6. 定期メンテナンス

### 自動 (pg_cron / GitHub Actions)
| ジョブ | 頻度 | 内容 |
|---|---|---|
| `cleanup-expired-sessions` | 毎日 03:10 UTC | 期限切れセッション DELETE |
| `cleanup-old-error-logs` | 毎日 03:20 UTC | 90日経過したエラーログ DELETE |
| `cleanup-login-attempts` | 毎日 03:30 UTC | 7日経過したログイン試行 DELETE |
| `keep_supabase_alive` | 毎日 (GitHub Actions) | Supabase 無料枠の sleep 防止 |

### 手動 (四半期)
- [ ] Supabase Service Key / Anon Key のローテーション検討
- [ ] Stripe Webhook 署名秘密のローテーション
- [ ] `requirements.txt` 依存関係の脆弱性チェック (`pip-audit`)
- [ ] `auth_sessions` / `rpc_error_log` のレコード数確認
- [ ] バックアップから復元テスト

---

## 7. トラブルシューティング

### Q1. シフト生成が遅い・タイムアウト
- `python/scheduler.py` の `_solve_milp()` Tier3 タイムアウト 60秒
- スタッフ数 50人超は重い → Pro プラン (`stripe_plan='pro'`) で上限緩和

### Q2. ログインできない
```sql
-- ロック状態確認
SELECT * FROM login_attempts WHERE identifier LIKE '%<contract_id>%';

-- 解除
SELECT clear_login_failures('shop:<contract_id>');
SELECT clear_login_failures('admin:<contract_id>');
```

### Q3. 本部管理画面に入れない
- `hq_admins` テーブルが存在し、レコードがあるか確認
```sql
SELECT login_id FROM hq_admins;
```
- 無ければ migration 17 を再適用

### Q4. Stripe webhook が 401 を返す
- Railway 環境変数 `STRIPE_WEBHOOK_SECRET` が正しいか確認
- Stripe Dashboard で webhook URL が `https://<railway>/stripe/webhook` になっているか確認

### Q5. メールが届かない
- Railway 環境変数 `SMTP_HOST` `SMTP_USER` `SMTP_PASS` `INQUIRY_EMAIL_TO` 確認
- 送信先で迷惑メール扱いされていないか
- Railway logs で `Welcome email send failed` を grep

---

## 8. 緊急時の連絡先

| 事象 | 対応 |
|---|---|
| 本番DBダウン | Supabase status (https://status.supabase.com/) → 待機 |
| Railway ダウン | Railway status (https://status.railway.app/) → 待機 |
| Cloudflare Pages ダウン | Cloudflare status → 待機 |
| Stripe 決済不可 | Stripe Dashboard で Webhook 再送、Customer に手動連絡 |
| データ漏洩疑い | 全 API キー即時ローテーション、`auth_sessions` 全削除、ユーザー通知 |
