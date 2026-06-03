# ラクシフトAI サービス仕様書

> 最終更新: 2026年6月3日  
> バージョン: 3.7.27

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

### 3.2 制約階層 (v3.7.27 現在)

| 階層 | 種類 | 緩和可否 | 詳細 |
|------|------|---------|------|
| HARD | 労基法（32条/34条/35条） + 勤務間インターバル | 不可 | 1日1シフト、週40時間、連続6日上限、勤務間10時間 |
| SOFT (大) | カバレッジ過不足 | 罰金で緩和 | UNDER 5M / OVER 8M（v3.7.27 で 4M→8M に強化、ぴったり配置を実現） |
| SOFT (大) | 社員 (月給+店長) 1名以上常駐 | 罰金 10M | OPEN_CLOSE_NO_EMP（旧 MIN_MANAGER 制約を置換） |
| SOFT (大) | 希望シフト充足 | 罰金 / ボーナス | EXACT -3M / CLOSE -2M / BASE -1.5M |
| SOFT (中) | 担当ポジション充足 | 罰金 3M | ホール/キッチン等の必要人数 |
| SOFT (中) | OJT メンター帯同 | 罰金 500k | 新人 (rookie) 配置時に管理者 or リーダーを同時間帯に同席 |
| SOFT (中) | 月/週最低出勤日数 | 罰金 200k | min_days_week / min_days_month (v3.7.18〜 HARD→SOFT 化) |
| SOFT (中) | 必須ペア (req_pairs) | 罰金 100k | 設定されたペアの同時出勤 |
| SOFT (小) | 離職防止 (全員週1配置) | 罰金 50k | v3.7.21 で HARD→SOFT 化 |
| SOFT (小) | 公平性偏差 | 罰金 10k | 出勤回数の偏り |
| SOFT (小) | 属性ボーナス | ボーナス | PRIORITY_HIGH -10k / CONTRACT_REGULAR -2k / メンター主担当マッチング -1k 等 |

> **重要**: evaluation=="D" のスタッフは rookie (新人) 扱いから除外され、OJT メンター帯同制約の対象外となります (v3.7.23)。

### 3.3 フォールバック（実践的フェイルセーフ）
```
MILP (HARD+SOFT) → 解あり → 最適シフト
                 → Infeasible → SOFT を一部緩和して再求解
                              → 解なし → 貪欲法（Greedy）
                                    ↓
人員不足でどうにもならない場合、is_irregular=True（イレギュラーフラグ）を立てて強制配置。
UI上で赤斜線の太枠として警告表示し、店長の目視確認・修正を促す（Human-in-the-loop）。
```

### 3.4 Gemini AI監査
- 生成後のシフトをGemini APIに送信
- 労基法違反/NG日配置/連勤超過をチェック
- 違反があれば修正シフトを返却

### 3.5 廃止された制約・機能（v3.7.16〜v3.7.21 の改修で削除）

| 削除機能 | 旧仕様 | 廃止理由 |
|---------|-------|---------|
| 戦力バランス制約 (POWER_BALANCE) | スタッフのスキル合計を一定に揃える | 過剰配置を誘発したため |
| ピーク帯スキルミックス (PEAK_SKILL) | ピーク時間帯にベテラン優先配置 | 希望シフト尊重を阻害 |
| 連続5日後の疲労インセンティブ (CONSEC_DAYS_FATIGUE) | 5日連勤後の翌日休み誘導 | 労基35条 + 勤務間10時間で代替 |
| 土日ローテーション公平性 (WEEKEND_FAIR) | 土日出勤を全員均等に | 希望時間 + 公平性偏差で代替 |
| 時間帯分散 (TIMEBAND_IMBALANCE) | 朝/昼/夕の3区分でバランス | カバレッジ制約で代替 |
| 管理者常駐 (MIN_MANAGER) | min_manager 人の管理者常駐 | 「社員1名以上常駐」(OPEN_CLOSE_NO_EMP) に変更 |
| NGペア制約 | 相性悪いスタッフを同時配置しない | アルゴリズム + UI 両方削除 |
| 人件費×評価ランク最小化 | 時給×時間 + 評価ランクペナルティ | 希望シフト尊重を優先 |
| 月給スタッフ強制出勤ペナルティ | 月給スタッフ未出勤に 30,000 点ペナルティ | 過剰配置を誘発 |

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
| シフト表 | ガントチャート（背景グリッドを排除した見やすいUI） / カレンダー / リスト |
| 申請リスト | 休み希望の承認/却下 |
| 分析・レポート | 月間統計、AI診断 |
| スタッフ管理 | CRUD、評価、勤務条件（最低出勤日数等）、希望時間考慮トグル、担当ポジション、必須ペア。**需給バランス警告バナー** (全員の min_days_month 合計 vs 月需要を表示し過剰を検知)、**土日希望時間 自動補完** (時給制スタッフの土日希望が空欄なら平日希望時間を自動コピー) |
| 店舗設定 | 営業時間、ポジション設定（自由追加）、シフトパターン、パスワード変更 |

#### 5.1.1 スタッフ管理画面の補助機能 (v3.7.25〜v3.7.27 追加)
- **需給バランス警告バナー**: 全スタッフの `min_days_month` 合計と月間需要 (営業日数 × 1日必要人員) を比較し、過剰登録を可視化。シフト生成前に過剰人員に気付ける。
- **土日希望時間 自動補完**: 時給制スタッフで土日 (pref_start_we / pref_end_we) が空欄の場合、平日希望時間 (pref_start_wd / pref_end_wd) を自動コピーして欠落を防止。
- **時間入力 UI 改善**: ドロップダウン → `<input type="time">` に変更し、キーボード打ち込みで素早く入力可能に。

### 5.2 シフト生成プレビュー
1. AIが生成 → ローディング画面（豆知識ローテーション）
2. **プレビューモーダル表示** — 統計サマリー4項目 + 日別シフト一覧
   - ※AIが無理やり配置した箇所は「赤斜線の太枠（イレギュラーアラート）」として視覚的に警告。
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

---

## 8. 変更履歴 (v3.7.16〜v3.7.27 / 2026-06 改修)

### 廃止された機能 (v3.7.16〜v3.7.21)
- 戦力バランス制約 (POWER_BALANCE)
- ピーク帯スキルミックス制約 (PEAK_SKILL)
- 連続5日後の疲労インセンティブ (CONSEC_DAYS_FATIGUE)
- 土日ローテーション公平性制約 (WEEKEND_FAIR)
- 時間帯分散制約 (TIMEBAND_IMBALANCE)
- 管理者常駐制約 (MIN_MANAGER) → 「社員1名以上常駐」(OPEN_CLOSE_NO_EMP) に置換
- NGペア制約 (アルゴリズム + UI 両方削除)
- 人件費×評価ランク最小化
- 月給スタッフ強制出勤ペナルティ (30,000 点)
- 離職防止ハード制約 (週1日強制配置) → SOFT 化 (50k ペナルティ)

### 緩和された制約 (v3.7.18〜v3.7.23)
- OJT 制約 (新人×メンター): 3M → 500k に弱化
- min_days_week / min_days_month: HARD → SOFT 化 (200k ペナルティ)
- evaluation=="D" のスタッフを rookie 扱いから除外

### 追加された機能 (v3.7.25〜v3.7.27)
- 需給バランス警告バナー (スタッフ管理画面)
- 土日希望時間 自動補完 (時給制スタッフ)
- 時間入力 UI 改善 (ドロップダウン → input type="time")
- 過剰配置の根本解決 (COVERAGE_OVER 4M → 8M に強化)
