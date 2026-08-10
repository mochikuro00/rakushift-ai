# ==============================================================
# bump-version.ps1
# 用途: index.html / admin.html 内の <script src="js/xxx.js?v=YYYYMMDD"> の
#       ?v= 値を一括更新する
# 使い方:
#   powershell -ExecutionPolicy Bypass -File scripts\bump-version.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\bump-version.ps1 -Version 20260601
#
# 安全設計:
#   - script タグ行に限定して置換 (HTML本文には触らない)
#   - Get-Content / Set-Content を行単位で処理
#   - 置換前後の差分を表示
# ==============================================================

param(
    [string]$Version = (Get-Date -Format "yyyyMMdd")
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot

$targets = @(
    (Join-Path $Root "index.html"),
    (Join-Path $Root "admin.html")
)

# script タグ + js/*.js + ?v=英数字 にのみマッチする厳密パターン
$scriptPattern = '(<script\s+src="[^"]*\.js)\?v=[A-Za-z0-9]+(")'
$replacement = "`${1}?v=$Version`${2}"

$totalReplaced = 0
foreach ($file in $targets) {
    if (-not (Test-Path $file)) {
        Write-Warning "Skip: $file (not found)"
        continue
    }
    $lines = Get-Content -Path $file -Encoding UTF8
    $bumped = 0
    $newLines = foreach ($line in $lines) {
        if ($line -match $scriptPattern) {
            $bumped++
            $line -replace $scriptPattern, $replacement
        } else {
            $line
        }
    }
    if ($bumped -eq 0) {
        Write-Host "Skip: $file (no script ?v= found)" -ForegroundColor DarkGray
        continue
    }
    # UTF-8 (BOM なし) で書き戻し (PowerShell 5.1 互換)
    $utf8NoBom = New-Object -TypeName System.Text.UTF8Encoding -ArgumentList @($false)
    $joined = ($newLines -join "`r`n") + "`r`n"
    [System.IO.File]::WriteAllText($file, $joined, $utf8NoBom)
    Write-Host ("Bumped: {0} ({1} script tags -> ?v={2})" -f (Split-Path $file -Leaf), $bumped, $Version) -ForegroundColor Green
    $totalReplaced += $bumped
}

Write-Host ""
Write-Host ("Done. Total script tags updated: {0}" -f $totalReplaced) -ForegroundColor Cyan
Write-Host ""
Write-Host "Next: git add -A && git commit -m 'chore: bump asset version to $Version' && git push" -ForegroundColor Yellow
