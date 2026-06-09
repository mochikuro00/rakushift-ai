# セキュリティ運用ガイド

最終更新: 2026-06-10 (v3.7.132 追加軽減策 + 既存ログイン保護の確認)

このドキュメントはラクシフトAIの**セキュリティ設計と運用上の責務**をまとめた納品時参考資料です。
コード変更時・運用開始時に必ず一読してください。

---

## 🆕 v3.7.131 短期セキュリティ軽減策

### 実装済み (フロント/ヘッダーのみ、本番運用に影響なし)

| 対策 | 実装 | 効果 |
|---|---|---|
| **CSP (Content-Security-Policy)** | `_headers` で全ページに付与 | XSS でスクリプト実行を遮断 (Supabase / Stripe / CDN のみ許可) |
| **HSTS** | `max-age=31536000; preload` | ダウングレード攻撃防止、HTTPS強制 |
| **Permissions-Policy** | geolocation/camera/mic 等を禁止 | 不要な API へのアクセス遮断 |
| **本番 console.log 抑制** | `RAKUSHIFT_CONFIG.DEBUG=false` で log/info/debug を no-op に | デバッグ情報の漏洩防止。warn/error は残し障害時の捕捉可能 (ローカル開発は `?debug=1` で有効化) |
| **入力長制限の徹底** | 全主要フォーム input に maxlength | DoS / バッファ攻撃の軽減 |
| **電話番号 pattern** | `[0-9\-\+\(\)\s]+` 制限 | SQLi / インジェクション試行の入力段階での阻止 |
| **パスワード autocomplete** | `current-password` / `new-password` | パスワードマネージャー連携、誤入力防止 |

## 🆕 v3.7.132 追加対策

| 対策 | 実装 | 効果 |
|---|---|---|
| **SRI** (Subresource Integrity) | font-awesome / chart.js に `integrity` 属性 (sha384) | CDN 改竄時にスクリプト/CSSをブラウザが拒否 |
| **Honeypot field** | 問い合わせフォームに hidden input `inquiryWebsiteUrl` | bot が入力した場合は静かに破棄 (UX 影響なし) |
| **robots.txt** | AI クローラー (GPTBot/ChatGPT/Claude/Perplexity/Bytespider) 明示拒否 | LLM 学習からの個人情報吸い上げ防止 |
| **admin.html noindex** | `<meta name="robots" content="noindex,nofollow,noarchive">` | 管理画面が検索結果に出ない |
| **エラー通知 webhook** | 環境変数 `ERROR_WEBHOOK_URL` を設定すると未捕捉例外を Slack/Discord に通知 (5分間 重複抑制) | 本番障害の即時検知 |
| **依存脆弱性スキャン** | `.github/workflows/security_audit.yml` で pip-audit を週次 + push 時実行 | 既知 CVE を自動検出、Issue 化 |
| **既存ログイン保護の検証** | shop/admin/hq の全 3 経路で `can_attempt_login` を事前チェック確認済 | 10回失敗で5分ロック (migration 26 で実装済) |

### 次フェーズ候補: オプトイン PIN (大規模改修)

**ユーザー要望としてはあったが、リスクと工数を考慮し別セッションで実装予定**

設計案:
- `config` テーブルに `pin_hash TEXT NULL` 追加
- 既存ユーザーは `pin_hash=NULL` で従来通り (オプトイン)
- PIN 設定済ユーザーはログイン後に PIN 入力モーダル
- RPC 3つ: `verify_pin_by_contract / set_pin_by_contract / clear_pin_by_contract`
- 工数: 2-3セッション
- リスク: ログインフロー変更のため、既存ユーザーへの影響テスト必要

### Cloudflare 側で手動設定すべき項目 (ダッシュボードで実施)

```
Cloudflare ダッシュボード > Security > WAF / Rate Limiting:

1. Rate Limiting Rules (推奨設定)
   - /api/inquiry        : 5 req/min/IP
   - /auth/*             : 10 req/min/IP
   - /rest/v1/rpc/*      : 60 req/min/IP
   - /rest/v1/*          : 200 req/min/IP

2. Bot Fight Mode: ON
3. Browser Integrity Check: ON
4. Challenge Passage: 30 分
5. (任意) Country block: 海外からのアクセス遮断
```

### 既知の制限 (次フェーズで根本対応予定)

| 制限 | 影響 | 対策候補 |
|---|---|---|
| RPC が `contract_id` 単一認証 | 攻撃者が contract_id を入手すれば操作可能 | PIN/JWT 追加 (大改修 1-2ヶ月) |
| `localStorage` に `organization_id` を平文保存 | ブラウザ侵害時のテナント情報漏洩 | Web Crypto API で暗号化 |
| Supabase Anon Key がフロントに露出 | 仕様 (公開前提)。RLS で本人以外触れない | 変更不要 (現状で正解) |

---

## 1. アーキテクチャと信頼境界

```
[ブラウザ]
  ↓ (HTTPS, anon key + x-session-id ヘッダー)
[Cloudflare Pages: index.html / admin.html / js/*.js]
  ↓ (REST/RPC, anon key)         ↓ (REST, x-session-id)
[Supabase PostgreSQL + RLS]      [Railway: FastAPI + PuLP]
                                  ↓ (SERVICE_KEY)
                                  └→ [Supabase] (RLS バイパス)
```

**信頼境界**:
- フロントから来る入力 (`organization_id`, `contract_id`, `staff_list` など) は **全て untrusted**
- 認可は **Supabase RLS** と **Python 側 `verify_session_org_id`** の二重で行う
- Anon Key は公開前提だが、Service Key は Railway 環境変数にのみ保存

---

## 2. 認証と認可

### ロール
| ロール | セッション発行RPC | `organization_id` |
|---|---|---|
| `shop` | `verify_shop_login` | テナントの org_id |
| `admin` | `verify_admin_login` | テナントの org_id |
| `hq_admin` | `hq_login` | **NULL** (全テナント横断) |

### セッション管理
- セッション ID は `auth_sessions` テーブルに発行され、TTL 7日
- フロントは `sessionStorage` に保存（タブ閉じで消滅 → XSS 持続性を低減）
- HTTP ヘッダー `x-session-id` で送信
- PostgREST 側で `get_session_id()` / `get_session_org_id()` / `get_session_role()` がヘッダーから取得
- **期限切れセッションは pg_cron で日次 DELETE** (migration 25)

### ログイン試行のレート制限
- migration 26 で `login_attempts` テーブル + `can_attempt_login` / `record_login_failure` / `clear_login_failures` RPC を提供
- 同一識別子 (`shop:<contract_id>` 等) に対し **5分間で10回失敗→5分間ロック**
- フロントは `_checkLoginLock` (ローカル) + サーバRPC の二重で防御

### ⚠️ 既知のバックドア (運営者判断で残存)
- `verify_shop_login` / `verify_admin_login` 内のマスターパスワード `'rakushift1234'` は **意図的に残されている** (2026-05-22 運営者判断)
- `js/app_v2.js` の `HQ_ACCOUNTS` フォールバックも同様に残存
- `admin_password` は **平文保存**、`config_safe` ビューで anon にも公開されている
- 上記は本来 Critical 級の問題。**本格運用前に必ず削除すること**

---

## 3. Row Level Security (RLS)

全ての公開スキーマテーブルで RLS 有効化済み:

| テーブル | 主なポリシー |
|---|---|
| `organizations` | `org_select_by_org`: 自テナント or hq_admin |
| `config` | 同上 |
| `staff` / `shifts` / `requests` | `organization_id = get_session_org_id() OR hq_admin` |
| `announcements` | セッションを持つ全ロールが SELECT 可。CRUD は RPC 経由のみ |
| `auth_sessions` | 自セッションのみ SELECT/DELETE、hq_admin は全件 |
| `hq_admins` | anon 完全遮断 (`USING false`) |
| `rpc_error_log` | anon 完全遮断 |
| `login_attempts` | anon 完全遮断 |
| `platform_admins` / `platform_settings` / `referrers` | RPC 経由のみアクセス |

### Supabase Security Advisor で確認
- 適用後、Dashboard → Database → Advisors を開く
- `rls_disabled_in_public` 警告がゼロになっていることを必ず確認

---

## 4. SECURITY DEFINER 関数

69 個の `SECURITY DEFINER` 関数すべてに **migration 24** で `search_path = pg_catalog, public, extensions, pg_temp` を固定。
これにより CVE-2018-1058 系の search_path 攻撃 (汚染スキーマでの関数横取り) を防止。

### 新規 RPC 追加時のチェックリスト
1. `SECURITY DEFINER` が本当に必要か (`SECURITY INVOKER` で済むなら使わない)
2. `SET search_path = pg_catalog, public, extensions, pg_temp` を必ず付与
3. 入力 (`p_xxx`) は型と長さで validate
4. 失敗時 `SQLERRM` をそのまま返さない (`_log_rpc_error()` に記録して `log_id` だけ返す)
5. 権限チェック (hq_admin 限定など) は冒頭で `RAISE EXCEPTION`

---

## 5. シークレット管理

| シークレット | 保管場所 | 共有方法 |
|---|---|---|
| Supabase Anon Key | `js/config.js` (公開 OK) | リポジトリ内 |
| Supabase Service Key | Railway 環境変数 `SUPABASE_SERVICE_KEY` | Railway dashboard のみ |
| Stripe Secret Key | Supabase `platform_settings` (平文DB保存) | 運営管理者がDB経由 |
| Gemini / OpenAI API Key | Supabase `platform_settings` (平文DB保存) | 運営管理者がDB経由 |
| SMTP パスワード | Railway 環境変数 or `platform_settings` | 両対応 |
| Supabase Access Token (CLI) | GitHub Secrets `SUPABASE_ACCESS_TOKEN` | リポジトリ Settings |
| Migration Token | Railway 環境変数 `MIGRATION_TOKEN` | Railway dashboard のみ |

### ⚠️ 残課題
- API キーの DB 平文保存は中期的な改善点。Supabase Vault または `pgp_sym_encrypt` への移行推奨

### 漏洩時の対応
1. **Supabase Anon Key** が悪用されている → Dashboard で Rotate
2. **Service Key** 漏洩 → Dashboard → Project Settings → API → Reset、Railway 環境変数も更新
3. **Stripe Key** 漏洩 → Stripe Dashboard → API Keys → Roll、`platform_settings.value` を更新
4. **Personal Access Token** 漏洩 → https://supabase.com/dashboard/account/tokens で Delete、Github Secrets も更新

---

## 6. CORS / CSP / セキュリティヘッダー

### フロント
- `index.html` / `admin.html` に CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy を設定
- inline `onclick` のため `'unsafe-inline'` は許可中。将来 `addEventListener` 化で削除可能

### バックエンド (FastAPI)
- `ALLOWED_ORIGINS` 環境変数で本番フロント (`https://rakushift-ai.pages.dev` 等) のみ許可
- `allow_credentials=False`、wildcard は使わない

---

## 7. ログとモニタリング

| ログ種別 | 出力先 | 確認方法 |
|---|---|---|
| Python ログ | Railway logs | Railway dashboard |
| RPC エラー詳細 | `rpc_error_log` テーブル | Service Key で SELECT |
| Supabase クエリログ | Supabase Studio → Logs | Dashboard |
| Stripe webhook | Railway logs (`/stripe/webhook`) | Railway |
| ログイン試行 | `login_attempts` テーブル | Service Key で SELECT |

### 本番ログマスク
- `IS_PRODUCTION=1` (Railway) または `RAILWAY_ENVIRONMENT=production` で例外メッセージを抑制
- Stripe 例外メッセージは無条件にマスク済み

---

## 8. デプロイ / インフラ

### Railway (Python API)
- Dockerfile は **non-root (uid 10001) + multi-stage + HEALTHCHECK**
- `healthcheckPath = /health` で DB 疎通確認、失敗時自動 restart

### Cloudflare Pages (Frontend)
- GitHub `main` に push で自動デプロイ
- `js/config.js` はリポジトリ内 (Anon Key 含む、CALC_SERVER_URL 含む)

### Supabase (DB)
- マイグレーションは `supabase db push` または Studio で適用
- 失敗時は GitHub Actions が **Slack に通知** (`SLACK_WEBHOOK_URL` Secrets 設定時)

---

## 9. 障害時の連絡フロー

1. Railway デプロイ失敗 → Railway dashboard で再 deploy / ログ確認
2. Supabase Migration 失敗 → Slack 通知 (設定済の場合) → ロールバック用パッチを `_fix.sql` で追加
3. シフト生成失敗 → `/diagnose` API で原因確認、`/keepalive` で DB 疎通確認
4. ログインできない → `login_attempts` テーブル確認、必要なら `clear_login_failures` で解除

---

## 10. 引き継ぎチェックリスト

新オーナーは以下を最初の1週間で実施:

- [ ] このドキュメント (`SECURITY.md`) を一読
- [ ] [`DEPLOYMENT.md`](DEPLOYMENT.md) でデプロイ手順を確認
- [ ] Supabase Studio → Database → Advisors を開いて警告ゼロを確認
- [ ] Supabase の Service Key / PAT を新しい運営者の認証情報でローテーション
- [ ] GitHub Secrets (`SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD`) を更新
- [ ] Railway 環境変数 (`SUPABASE_SERVICE_KEY`, `ADMIN_API_TOKEN`, `MIGRATION_TOKEN`) を更新
- [ ] Stripe Dashboard で webhook 署名秘密を本番用に切り替え
- [ ] **マスターパスワード `'rakushift1234'` の扱いを正式に判断** (削除 / 残存)
- [ ] `admin_password` 平文保存を bcrypt 化するか判断
- [ ] デモテナント (`254995332101138`) を本番から分離するか判断
