FROM python:3.11-slim

ENV PYTHONUNBUFFERED=True
ENV BUILD_VERSION=2026.05.17.1
ENV LANG=C.UTF-8
ENV LC_ALL=C.UTF-8
ENV PYTHONIOENCODING=utf-8

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

CMD sh -c "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8080}"
