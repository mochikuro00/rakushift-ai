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

# サーバー起動 (Cloud Runの環境変数PORTを確実に読み込む設定)
CMD sh -c "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8080}"
