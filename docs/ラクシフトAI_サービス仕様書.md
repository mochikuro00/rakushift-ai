# ラクシフトAI サービス仕様書

> 最終更新: 2026年5月17日  
> バージョン: 3.1

---

## 1. システム構成

### アーキテクチャ図
```
[ユーザー] ─→ [Cloudflare Pages] ─→ [Supabase (DB/RPC)]
                   │
                   └─→ [Railway (Python FastAPI)]
                            │
                            ├── PuLP (MILP最適化)
                            ├── Gemini API (AI監査)
                            └── Stripe API (決済)
```

### インフラ構成

| コンポーネント | サービス | 役割 |
|-------------|---------|------|
| フロントエンド | Cloudflare Pages | HTML/JS配信、自動SSL |
| APIサーバー | Railway (Docker) | シフト生成、AI診断、決済 |
| データベース | Supabase (PostgreSQL) | データ永続化、RPC、RLS |
| 決済 | Stripe | サブスクリプション課金 |
| CI/CD | GitHub Actions | Supabase keepalive |

---

## 2. API仕様

### 2.1 シフト生成 API

**POST /generate**
- レート制限: 10回/分
- 認証: なし（プラン検証はサーバー側で実施）

リクエスト:
```json
{
  "staff_list": [{"id": "uuid", "name": "田中", "role": "manager", ...}],
  "config": {"opening_time": "09:00", "closing_time": "22:00", ...},
  "dates": ["2026-05-01", "2026-05-02"],
  "requests": [{"staff_id": "uuid", "date": "2026-05-01", "type": "off"}],
  "mode": "auto",
  "contract_id": "254995332101138"
}
```

レスポンス:
```json
{
  "status": "success",
  "mode": "math_plus_gemini_audit",
  "shifts": [
    {"staff_id": "uuid", "date": "2026-05-01", "start_time": "09:00", "end_time": "18:00", "break_minutes": 60}
  ]
}
```

### 2.2 AI診断 API

**POST /diagnose** — Gemini AIがシフトの問題点を分析
- レート制限: 10回/分

レスポンス:
```json
{
  "status": "success",
  "suggestions": [
    {"type": "danger", "title": "労基法違反の可能性", "desc": "...", "action": "..."},
    {"type": "warning", "title": "人員不足", "desc": "...", "action": "..."}
  ]
}
```

### 2.3 事前チェック API

**POST /check** — シフト生成前の人員充足チェック
- レート制限: 20回/分

### 2.4 Stripe API群

| エンドポイント | レート制限 | 用途 |
|-------------|----------|------|
| POST `/stripe/new-subscription` | 5/min | 新規申込 → Checkoutセッション |
| POST `/stripe/create-checkout` | 5/min | 既存テナントのプラン変更 |
| POST `/stripe/create-portal` | — | Stripeカスタマーポータル |
| POST `/stripe/webhook` | — | Webhook受信（署名検証付き） |
| GET `/stripe/subscription-status/{id}` | — | サブスク状態確認 |
| POST `/admin/send-welcome-email` | — | ウェルカムメール送信 |

---

## 3. 最適化エンジン仕様

### 3.1 アルゴリズム
- **MILP (Mixed Integer Linear Programming)** — PuLPライブラリ使用
- ソルバー: CBC（デフォルト）、Tierごとにタイムアウト段階化（Tier3: 60秒, Tier2: 30秒, Tier1: 20秒）

### 3.2 制約階層

| 階層 | 種類 | 緩和可否 |
|------|------|---------|
| Tier 1 | 労基法（32条/34条/35条） | 不可 |
| Tier 2 | 店舗ルール（人員/管理者/定休日） | 条件付き可 |
| Tier 3 | 最適化（コスト/均等/バランス） | 可 |

### 3.3 フォールバック
```
Tier 1+2+3 → 解あり → 最適シフト
         → 解なし → Tier 1+2 再挑戦
                  → 解なし → 貪欲法（Greedy）
```

### 3.4 Gemini AI監査
- 生成後のシフトをGemini APIに送信
- 労基法違反/NG日配置/連勤超過をチェック
- 違反があれば修正シフトを返却

---

## 4. データベース仕様

### 4.1 認証フロー

**店舗ログイン:**
```
verify_shop_login(contract_id, password)
  1. 店舗設定パスワードでbcrypt照合
  2. 不一致 → マスターパスワード('rakushift1234')で照合
  3. どちらか一致 → organization_id返却
```

**管理者ログイン:**
```
verify_admin_login(contract_id, login_id, password)
  → staffテーブルからbcrypt照合
```

### 4.2 マルチテナント分離
- 全テーブルに `organization_id` カラム
- RLS (Row Level Security) で完全分離
- anon keyでは他テナントのデータにアクセス不可

---

## 5. フロントエンド仕様

### 5.1 ビュー構成
| ビュー | 説明 |
|-------|------|
| ダッシュボード | 今日の出勤、統計サマリー |
| シフト表 | ガントチャート / カレンダー / リスト |
| 申請リスト | 休み希望の承認/却下 |
| 分析・レポート | 月間統計、AI診断 |
| スタッフ管理 | CRUD、評価、勤務条件 |
| 店舗設定 | 営業時間、シフトパターン、パスワード変更 |

### 5.2 シフト生成プレビュー
1. AIが生成 → ローディング画面（豆知識ローテーション）
2. **プレビューモーダル表示** — 統計サマリー4項目 + 日別シフト一覧
3. ユーザーが「確定して保存」で初めてDB保存
4. 「キャンセル」で破棄

### 5.3 シフトパターンプリセット
| プリセット | パターン例 |
|-----------|----------|
| 飲食店向け | 早番/中番/遅番/通し/ランチ/ディナー |
| オフィス向け | 日勤/早番/遅番/半日AM/半日PM |
| 小売店向け | 早番/遅番/通し/午前/午後/夕方 |
| 医療・介護向け | 日勤/早番/遅番/夜勤/準夜勤/半日 |

---

## 6. セキュリティ仕様

| 項目 | 実装 |
|------|------|
| パスワード保存 | bcrypt (pgcrypto, gen_salt('bf')) |
| CORS | 本番ドメインのみ許可 |
| レート制限 | slowapi (IP単位) |
| API認証 | Supabase Anon Key (RLS付き) |
| Webhook | Stripe署名検証 |
| セキュリティビュー | config_safe, staff_safe |
| 管理API保護 | `ADMIN_API_TOKEN`環境変数による認証 |
| マイグレーション保護 | `MIGRATION_TOKEN`環境変数必須 |
| httpx接続プール | グローバルクライアントで接続再利用 |

---

## 7. 非機能要件

| 項目 | 仕様 |
|------|------|
| 可用性 | Cloudflare CDN + Railway自動復旧 |
| スケーラビリティ | Docker水平スケール可能 |
| レスポンス | シフト生成 < 60秒 |
| データ保持 | 解約後6ヶ月間保持 |
| バックアップ | Supabase自動バックアップ |
