# 運営管理者コンソール 再現用ブループリント

別システムで「運営管理者コンソール（platform admin console）」を再現するための設計仕様。
末尾に **AIへコピペで渡せる指示テンプレート** あり。

---

## 1. アーキテクチャ（3層・サーバレス寄り）

| 層 | 技術 | 役割 |
|---|---|---|
| **UI** | 単一 `admin.html`（Tailwind CDN + 素のJS、ビルド不要） | タブ切替のSPA。状態は `sessionStorage` |
| **データ/権限** | Supabase(PostgreSQL) の **RPC関数**（`SECURITY DEFINER`）| CRUD・認証・権限判定をすべてDB関数に集約。テーブル直アクセスはRLSで遮断 |
| **補助API** | FastAPI(Python) の `/admin/*` | 外部SaaS(Stripe等)連携・集計・メール送信のみ担当 |

ポイント: **業務ロジックはDB関数(RPC)に寄せる**。フロントは「RPCを呼んで結果を描画するだけ」。これで認証・権限を一箇所（DB）で担保できる。

---

## 2. 認証・権限モデル（最重要）

### 仕組み
1. `platform_admins` テーブル（`login_id`, `password`=bcryptハッシュ, `name`）に管理者を登録。
2. ログインRPC `verify_platform_admin_login(login_id, password)`:
   - bcrypt照合（`password = crypt(input, password)`）
   - 成功時 `auth_sessions` に `role='platform_admin'`, `actor_id`, `expires_at=now()+7日` を発行
   - 戻り値に `session_id`(UUID) を含める
3. フロントは `session_id` を `sessionStorage` に保存し、**以降すべてのRPC呼び出しで HTTPヘッダ `x-session-id` に付与**。
4. DB側ヘルパーがヘッダからセッションを復元して権限判定:
   ```sql
   -- リクエストヘッダから session_id を取り出す
   CREATE FUNCTION get_session_id() RETURNS UUID AS $$
     RETURN NULLIF(current_setting('request.headers', true)::json->>'x-session-id','')::uuid;
   $$ ...;
   -- そのセッションの role を返す
   CREATE FUNCTION get_session_role() RETURNS TEXT ...; -- auth_sessions を引く
   ```
5. 各業務RPCの先頭で `role IN ('platform_admin', ...)` を検査。違えば `RAISE EXCEPTION 'Access denied'`。

### なぜこの形か
- **Supabase の anon key は誰でも持てる**ので、それだけでは認可にならない。`x-session-id`→`auth_sessions`→`role` の連鎖で「本物の運営管理者か」をDB内で判定する。
- フロントを改ざんしても、DB関数が role を再検査するので**権限昇格できない**（サーバ真実）。

### セキュリティ必須事項
- パスワードは **bcrypt**（`pgcrypto` の `crypt()/gen_salt('bf')`）。平文・SHA禁止。
- 全テーブルに **RLS(Row Level Security) 有効化**＋直接 SELECT/UPDATE を原則拒否。操作は `SECURITY DEFINER` RPC 経由のみ。
- セッションは **TTL(7日) + 期限切れ自動削除**（pg_cron `cleanup-expired-sessions`）。
- ログイン試行の記録・レート制限（`login_attempts` テーブル + cleanup cron）。

---

## 3. タブ構成（9パネル）

各タブ = `<div id="panelXxx">` + `switchTab('xxx')` で表示切替。

| タブ | パネルID | 機能 | 主要RPC |
|---|---|---|---|
| テナント管理 | panelTenants | 契約店舗の一覧/新規発行/停止/復活/データ削除/PINリセット | `list_tenants`, `create_tenant`, `suspend_license`, `activate_license`, `delete_tenant_data`, `update_tenant_metadata`, `admin_reset_pin_by_contract` |
| 顧客情報 | panelCustomers | 全ソース(契約/見込み/解約)を統合した顧客台帳・請求カテゴリー別 | 補助API `/admin/customers` |
| 支払い管理 | panelPayments | Stripe決済(入金/未収)一覧 | 補助API `/admin/stripe/payments` |
| 事業収益 | panelRevenue | MRR・プラン別集計・顧客別収益一覧(請求カテゴリータブ＋ソート) | `list_tenants`(クライアント集計) |
| 本部管理者 | panelHqadmins | 中間管理者(本部)の発行・管轄店舗スコープ設定 | `list_hq_admins`, `create_hq_admin`, `update_hq_admin_scope`, `delete_hq_admin`, `register_store_to_hq` |
| 紹介者管理 | panelReferrers | 紹介者(代理店)の登録・振込先・紹介実績 | `list_referrers`, `create_referrer`, `update_referrer`, `delete_referrer`, `list_referrer_clients` |
| お問い合わせ | panelInquiries | 見込み客の問い合わせ管理・ステータス更新 | `list_inquiries`, `get_inquiry`, `update_inquiry` |
| お知らせ配信 | panelAnnouncements | 全テナントへの通知配信 | `list_all_announcements`, `create_announcement`, `update_announcement`, `delete_announcement` |
| 運営マニュアル | panelManual | 静的な運用手順ドキュメント（DB不要） | なし |

> 汎用化する場合、**「テナント管理・認証・収益・お知らせ」がコア**。他は業種依存なので取捨選択。

---

## 4. データモデル（主要テーブル）

```
platform_admins(id, login_id, password[bcrypt], name)           -- 運営管理者
auth_sessions(id, role, actor_id, expires_at)                   -- 全ロール共通セッション
tenants/organizations(id, contract_id, name, stripe_customer_id,-- 契約テナント
    stripe_plan, subscription_status, license_status, ...)
config(organization_id, company_name, address, phone, ...)      -- テナント別設定
hq_admins(id, login_id, password, is_global, scope[])           -- 中間管理者
referrers(id, code, name, bank_account, ...)                    -- 紹介者
inquiries(id, business_name, email, status, ...)               -- 見込み客
announcements(id, title, body, published_at)                   -- お知らせ
login_attempts(...) / rpc_error_logs(...)                       -- 監査
```

契約状態は2軸で管理:
- `subscription_status`（Stripe: active/canceled/…）＝**課金**の状態
- `license_status`（active/suspended）＝**アクセス**の状態
両者を分けることで「解約後6ヶ月はデータ保持（suspended）→期限後に削除」が表現できる。

---

## 5. フロントの型（admin.html の骨格）

```js
const SUPABASE_URL = '...'; const SUPABASE_KEY = '...anon...';

// 全RPC呼び出しの共通ラッパ: x-session-id を必ず付与
async function rpc(fn, params={}) {
  const sess = JSON.parse(sessionStorage.getItem('platform_admin')||'null');
  const headers = { 'Content-Type':'application/json',
    'apikey':SUPABASE_KEY, 'Authorization':`Bearer ${SUPABASE_KEY}` };
  if (sess?.session_id) headers['x-session-id'] = sess.session_id;   // ←権限の要
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`,
    { method:'POST', headers, body:JSON.stringify(params) });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function platformLogin() {
  const r = await rpc('verify_platform_admin_login', {p_login_id, p_password});
  if (r.success) sessionStorage.setItem('platform_admin', JSON.stringify(r));
}
function switchTab(name){ /* 全panelをhidden→対象をshow、対応loadXxx()呼ぶ */ }
```

### XSS防御（DB出力をHTMLに描画するため必須）
- テキスト差し込み → `escapeHtml()`（`& < > " '` をエンティティ化）
- `onclick="fn('...')"` の引数 → `jsAttr()`（JS文字列コンテキスト用エスケープ）
- 2つを**用途で使い分ける**（テキスト欄にjsAttrを使うと `McDonald\'s` のように壊れる）。

---

## 6. 補助API（FastAPI）の役割分担

DB関数でやりにくい「外部連携・重い集計」だけをPythonに置く:
- `GET /admin/customers` … tenants+leads+cancelling を統合、Stripe名で補完（`asyncio.wait_for` でタイムアウト保護）、請求カテゴリー(stripe/oem/invoice)を付与
- `GET /admin/stripe/payments` … Stripe Invoice API から入金/未収を集計
- `POST /admin/send-welcome-email` … SMTP送信

補助APIも `x-session-id` を受け取りDBでrole検査するか、サーバ間シークレットで保護する。

---

## 7. 運用の自動化（pg_cron）

```
cleanup-expired-sessions   -- 期限切れセッション削除
cleanup-login-attempts     -- ログイン試行ログ削除
cleanup-old-error-logs     -- RPCエラーログ削除
retention-old-*            -- 古い業務データの保持期間管理
auto-suspend-cancelled     -- 解約発効日を過ぎた契約を自動 suspend
```

---

## 8. AIへの指示テンプレート（コピペ用）

> 以下をそのまま別プロジェクトのAI/開発者に渡すと、同型コンソールを再現できます。
> `【】` を自分のドメインに置換してください。

```
Supabase(PostgreSQL) + 単一HTML(admin.html) + FastAPI補助API で
「運営管理者コンソール」を作って。要件:

■ 認証（サーバ真実・権限昇格不可にする）
- platform_admins(login_id, password=bcrypt, name) を作る
- 全ロール共通の auth_sessions(id, role, actor_id, expires_at) を作る
- RPC verify_platform_admin_login(login_id,password): bcrypt照合→
  auth_sessions に role='platform_admin' で7日TTLセッション発行→session_id返す
- get_session_id() は current_setting('request.headers')->>'x-session-id' を読む
- get_session_role() は auth_sessions を引く
- 全業務RPCは SECURITY DEFINER。先頭で role を検査し違えば例外
- 全テーブル RLS 有効・直接アクセス拒否。操作はRPC経由のみ
- パスワードは pgcrypto の bcrypt。平文禁止

■ フロント（admin.html・ビルド不要）
- Tailwind CDN + 素のJS。状態は sessionStorage('platform_admin')
- 共通 rpc(fn,params) ラッパが毎回ヘッダ x-session-id を付ける
- タブUI: 【テナント管理 / 収益 / お知らせ / …】を panel + switchTab で切替
- DB出力の描画は escapeHtml、onclick引数は jsAttr でXSS防御

■ タブ機能（必要なものだけ）
- テナント管理: list/create/suspend/activate/delete/metadata更新のRPC
- 収益: MRR・プラン別集計・顧客別一覧（カテゴリータブ＋列ソート）
- お知らせ: 全テナントへの配信CRUD
- 【業種固有タブ: 紹介者/問い合わせ/本部管理 等】

■ 補助API(FastAPI /admin/*)
- 外部SaaS連携(【Stripe等】)・重い集計・メール送信だけ担当
- x-session-id を受けDBでrole再検査

■ 運用
- pg_cron: 期限切れセッション削除 / ログイン試行削除 / 保持期間管理 /
  解約発効の自動suspend
- 契約状態は subscription_status(課金) と license_status(アクセス) の2軸で管理し、
  解約後の猶予保持→期限削除を表現できるようにする
```

---

**設計思想の要約**: 「権限判定をDB関数に一元化し、フロントは信用しない」。
これにより静的HTML1枚でも安全な管理コンソールになり、別システムへ移植しやすい。
