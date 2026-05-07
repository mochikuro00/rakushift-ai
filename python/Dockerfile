# 軽量なPythonイメージ
FROM python:3.9-slim

# 出力を見やすくする設定
ENV PYTHONUNBUFFERED True

# 作業ディレクトリ
WORKDIR /app

# ライブラリのインストール
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# コードのコピー
COPY . .

# サーバー起動（$PORT環境変数でポートを動的に設定）
CMD sh -c "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8080}"
