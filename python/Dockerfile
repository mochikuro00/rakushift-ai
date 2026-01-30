# 軽量なPythonイメージを使用
FROM python:3.9-slim

# 作業ディレクトリ
WORKDIR /app

# ライブラリのインストール
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# コードのコピー
COPY . .

# Cloud Run用ポート設定 (デフォルト8080)
ENV PORT 8080

# サーバー起動 (Uvicorn)
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080"]
