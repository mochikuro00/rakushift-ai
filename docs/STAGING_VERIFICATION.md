# ステージング 検証チェックリスト (v3.7.131)

> ステージング環境構築後、本番に近い動作をしているかを 30 項目で検証

ステージング URL: `https://staging.rakushift-ai.pages.dev` (実際の値は構築時の Cloudflare Preview URL)

---

## 1. 環境疎通 (5項目)

- [ ] フロント (Cloudflare Pages) ロード成功 (HTTP 200)
- [ ] バナーに「⚠ STAGING ENV ⚠」が表示される (黄色帯)
- [ ] Backend (Railway) 疎通: `curl https://rakushift-ai-staging.up.railway.app/health` → `{"status":"ok","db":"alive","version":"3.7.131"}`
- [ ] DB (Supabase) 接続: フロントから RPC 呼び出しでエラーが出ない
- [ ] 本番 DB が読み書きされていない (本番 Supabase Dashboard で確認)

## 2. 認証フロー (4項目)

- [ ] **店舗管理者ログイン**: テスト用 contract_id (`STAGING-TEST-001`) でログイン成功
- [ ] **本部統括ログイン**: HQ アカウントでログイン成功
- [ ] **運営管理ログイン**: `/admin.html` から admin 認証成功
- [ ] **チュートリアル**: 店舗管理者の初回ログイン時に自動表示

## 3. 主要機能 (12項目)

### スタッフ管理
- [ ] スタッフ追加 (名前/役割/給与/勤務制約)
- [ ] 連続出勤日数 (1-7日) の設定可能
- [ ] 該当シフトパターン (eligible_patterns) の設定可能
- [ ] 祝日NG (ng_holiday) の設定可能

### 店舗設定
- [ ] 営業時間・休業日の編集
- [ ] シフトパターン min/max 月間回数
- [ ] パターン人数 0 の反映

### シフト生成・編集
- [ ] AI シフト生成 (月単位、約1-2分)
- [ ] 連勤上限の厳守 (営業日ベース)
- [ ] ドラッグ&ドロップで移動
- [ ] ドラッグ&ドロップで入れ替え (swap)
- [ ] 連勤超過 DnD はトースト警告で中断

### 人員状況・印刷
- [ ] 人員状況「要件+過剰」内訳表示
- [ ] 印刷 PDF 出力

## 4. 過剰配置 ON/OFF (3項目)

- [ ] 過剰配置 OFF: 必要人数ぴったり配置 (補完なし)
- [ ] 過剰配置 ON: min_days_month 未達スタッフに補完配置
- [ ] 需給バランス表示が ON/OFF で切り替わる (適正/許容ラベル)

## 5. お問い合わせ (2項目)

- [ ] 法人・複数店舗お問い合わせフォーム送信成功
- [ ] inquiries テーブルにレコード作成確認 (Supabase Dashboard)

## 6. レスポンシブ (4項目)

- [ ] Desktop (1280x800) で UI 崩れなし
- [ ] iPad (768x1024) で UI 崩れなし
- [ ] iPhone 12 (390x844) で小タップ要素なし
- [ ] iPhone SE (320x568) で UI 操作可能

---

## 自動検証スクリプト

```powershell
# ステージング URL を指定して Playwright スモークテスト
$env:STAGING_URL = "https://staging.rakushift-ai.pages.dev"
python python/tests/smoke_staging.py
```

→ `python/tests/smoke_staging.py` で 3画面 × 2ビューポートを自動確認

---

## 検証完了後

- [ ] 検証結果をスクリーンショット保存
- [ ] 問題があれば `staging` ブランチで修正 → 再検証
- [ ] OK なら `main` にマージ → 本番デプロイ

---

最終更新: 2026-06-10
