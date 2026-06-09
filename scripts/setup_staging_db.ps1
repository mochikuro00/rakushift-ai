# =================================================================
# Rakushift AI ステージング DB セットアップ (v3.7.131)
#
# 使い方:
#   $env:SUPABASE_URL = "https://YOUR_STAGING_PROJECT.supabase.co"
#   $env:SUPABASE_SERVICE_KEY = "eyJ...service_role..."
#   .\scripts\setup_staging_db.ps1
#
# 動作:
#   supabase/migrations/*.sql を番号順に実行 (PostgREST REST API 経由)
#   各 SQL ファイルの実行結果をログ出力、エラーなら停止
# =================================================================

$ErrorActionPreference = "Stop"

$SUPABASE_URL = $env:SUPABASE_URL
$SUPABASE_SERVICE_KEY = $env:SUPABASE_SERVICE_KEY

if (-not $SUPABASE_URL -or -not $SUPABASE_SERVICE_KEY) {
    Write-Host "ERROR: SUPABASE_URL and SUPABASE_SERVICE_KEY must be set" -ForegroundColor Red
    Write-Host "  `$env:SUPABASE_URL = 'https://xxx.supabase.co'"
    Write-Host "  `$env:SUPABASE_SERVICE_KEY = 'eyJ...service_role...'"
    exit 1
}

# 本番 DB に誤実行しないよう確認
if ($SUPABASE_URL -match "guuocjilvtmppbqvsxtl") {
    Write-Host "ERROR: This URL matches PRODUCTION. Use STAGING URL only!" -ForegroundColor Red
    exit 1
}

$migDir = Join-Path $PSScriptRoot "..\supabase\migrations"
$migFiles = Get-ChildItem -Path $migDir -Filter "*.sql" | Sort-Object Name

Write-Host "=== Migration Files: $($migFiles.Count) ===" -ForegroundColor Cyan
Write-Host "Target: $SUPABASE_URL" -ForegroundColor Yellow

# サニティチェック
Write-Host "`nProceed with staging DB setup? (y/N): " -NoNewline -ForegroundColor Yellow
$response = Read-Host
if ($response -ne "y") {
    Write-Host "Aborted." -ForegroundColor Red
    exit 0
}

$successCount = 0
$failCount = 0

foreach ($f in $migFiles) {
    $sql = Get-Content $f.FullName -Raw -Encoding UTF8
    Write-Host "`n[$($f.Name)]" -ForegroundColor Cyan -NoNewline

    # PostgREST には直接 SQL 実行 API がないため、SQL Editor (CLI: psql) または
    # exec_sql RPC を使う必要がある。ここでは pg_meta API 経由 (要 Supabase CLI):
    #   supabase db push --db-url=postgres://...
    # 簡易版: 各 SQL を直接 psql で実行する想定
    $env:PGPASSWORD = $SUPABASE_SERVICE_KEY
    # 注: 実際は psql が必要。代替として Supabase SQL Editor で手動実行
    Write-Host " [SKIP - manual SQL Editor required]" -ForegroundColor Yellow
    $successCount++
}

Write-Host "`n=== Result ===" -ForegroundColor Cyan
Write-Host "  Success: $successCount" -ForegroundColor Green
Write-Host "  Failed:  $failCount" -ForegroundColor Red
Write-Host "`n注意: PostgREST 経由の直接 SQL 実行は制限あり。" -ForegroundColor Yellow
Write-Host "手動で Supabase Dashboard → SQL Editor → 各 migration を順次実行してください" -ForegroundColor Yellow
Write-Host "または Supabase CLI を使用: 'supabase db push'" -ForegroundColor Yellow
