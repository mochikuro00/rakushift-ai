# 軽量なPythonイメージを使用
FROM python:3.9-slim

# 作業ディレクトリ
WORKDIR /app

# ライブラリのインストール
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# コードのコピー
COPY . .

# サーバー起動 (環境変数PORTに従う設定)
CMD sh -c "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8080}"
