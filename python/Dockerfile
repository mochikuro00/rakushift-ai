FROM python:3.9-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# ポート8080で起動する設定
CMD uvicorn main:app --host 0.0.0.0 --port 8080
