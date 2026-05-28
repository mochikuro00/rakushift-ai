# Scheduler テスト

シフト生成エンジン (`scheduler.py`) の自動テスト。

## ローカル実行

```powershell
# 依存インストール (初回のみ)
cd python
pip install -r requirements-dev.txt

# 全テスト実行
pytest tests/

# 特定ファイルのみ
pytest tests/test_utils.py

# 詳細出力
pytest tests/ -v

# 失敗で停止
pytest tests/ -x
```

## ファイル構成

| ファイル | 内容 |
|---|---|
| `conftest.py` | 共通フィクスチャ (テスト用スタッフ・config・日付) |
| `test_utils.py` | ユーティリティ関数 (時刻変換、曜日判定等) |
| `test_regressions.py` | v3.6 で修正したバグのリグレッションテスト |
| `test_e2e.py` | 実際にシフトを生成して結果を検証する E2E スモーク |

## CI

`main` ブランチへの push 時、`python/**` に変更があると
[`.github/workflows/test_scheduler.yml`](../../.github/workflows/test_scheduler.yml) が自動実行される。

## テスト追加方針

1. **バグを修正する前にテストを書く** (TDD)
2. クラス分割で関心事を整理
3. ソルバーの実行は遅いので、ユニットテスト ≫ E2E の比率を保つ
4. E2E は `force=False` で「解が出ること」と「明確な違反がないこと」を確認するに留める
5. 解の具体的な内容 (誰がどこに配置されるか) は MILP の確率的挙動でブレるので避ける
