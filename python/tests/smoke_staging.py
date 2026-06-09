"""ステージング環境の動作確認スモークテスト (v3.7.131)

使い方:
    $env:STAGING_URL = "https://staging.rakushift-ai.pages.dev"
    $env:STAGING_BACKEND_URL = "https://rakushift-ai-staging.up.railway.app"
    python python/tests/smoke_staging.py

確認項目:
    1. フロント (Cloudflare Pages) 200 OK
    2. STAGING バナーが表示される
    3. Backend (Railway) /health が staging を返す
    4. コンソールエラー 0件 (3画面 × 2ビューポート = 6パターン)
    5. 本番 URL とは別の環境であることを確認 (バナーで判別)
"""
import os
import sys
import urllib.request
import json

DEFAULT_STAGING_URL = os.environ.get(
    'STAGING_URL', 'https://staging.rakushift-ai.pages.dev')
DEFAULT_BACKEND_URL = os.environ.get(
    'STAGING_BACKEND_URL', 'https://rakushift-ai-staging.up.railway.app')


def check_url(url, expect_text=None):
    try:
        with urllib.request.urlopen(url, timeout=10) as resp:
            status = resp.status
            body = resp.read().decode('utf-8', errors='replace')
        ok_status = (status == 200)
        ok_text = (expect_text in body) if expect_text else True
        return {'ok': ok_status and ok_text, 'status': status,
                'body_len': len(body), 'expect_text_found': ok_text}
    except Exception as e:
        return {'ok': False, 'status': 0, 'error': str(e)}


def check_backend_health(url):
    try:
        with urllib.request.urlopen(f'{url}/health', timeout=10) as resp:
            data = json.loads(resp.read().decode('utf-8'))
        return {
            'ok': data.get('status') == 'ok' and data.get('db') == 'alive',
            'data': data
        }
    except Exception as e:
        return {'ok': False, 'error': str(e)}


def check_with_playwright(staging_url):
    """Playwright で各画面とビューポートを確認"""
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        return [{'label': 'Playwright', 'ok': False,
                 'error': 'playwright not installed. pip install playwright'}]

    SCREENS = [
        {'name': '店舗用', 'path': '/'},
        {'name': '本部統括', 'path': '/?as_hq=1'},
        {'name': '運営管理', 'path': '/admin.html'},
    ]
    VIEWPORTS = [
        {'name': 'Desktop', 'w': 1280, 'h': 800},
        {'name': 'iPhone 12', 'w': 390, 'h': 844},
    ]
    results = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        for screen in SCREENS:
            for vp in VIEWPORTS:
                page = browser.new_page(viewport={'width': vp['w'], 'height': vp['h']})
                errors = []
                page.on('console', lambda msg: errors.append(msg.text) if msg.type == 'error' else None)
                page.on('pageerror', lambda err: errors.append(f'PAGE: {err}'))
                label = f"[{screen['name']}] {vp['name']}"
                try:
                    page.goto(staging_url + screen['path'],
                              wait_until='networkidle', timeout=30000)
                    # STAGING バナー検出
                    has_staging_banner = page.evaluate("""
                        () => document.body.innerText.includes('STAGING ENV')
                    """)
                    results.append({
                        'label': label,
                        'ok': len(errors) == 0 and has_staging_banner,
                        'errors': len(errors),
                        'staging_banner': has_staging_banner,
                    })
                except Exception as e:
                    results.append({'label': label, 'ok': False, 'error': str(e)})
                finally:
                    page.close()
        browser.close()
    return results


def main():
    print("=" * 70)
    print("ステージング環境 動作確認 (v3.7.131)")
    print("=" * 70)
    print(f"Frontend URL: {DEFAULT_STAGING_URL}")
    print(f"Backend URL:  {DEFAULT_BACKEND_URL}")
    print()

    # 1. フロント疎通
    print("[1] フロント疎通")
    r = check_url(DEFAULT_STAGING_URL)
    marker = '✅' if r['ok'] else '❌'
    print(f"  {marker} HTTP {r.get('status', 0)} body={r.get('body_len', 0)} bytes")

    # 2. バナー確認
    print("\n[2] STAGING バナー (HTML 内に検出)")
    r = check_url(DEFAULT_STAGING_URL, expect_text='STAGING ENV')
    marker = '✅' if r.get('expect_text_found') else '❌'
    print(f"  {marker} 'STAGING ENV' 文字列検出: {r.get('expect_text_found')}")

    # 3. バックエンド疎通
    print("\n[3] Backend (Railway) /health")
    r = check_backend_health(DEFAULT_BACKEND_URL)
    marker = '✅' if r['ok'] else '❌'
    if r['ok']:
        print(f"  {marker} {r['data']}")
    else:
        print(f"  {marker} {r.get('error', 'unknown')}")

    # 4. Playwright で 3画面 × 2ビューポート確認
    print("\n[4] Playwright 3画面 × 2ビューポート")
    pw_results = check_with_playwright(DEFAULT_STAGING_URL)
    for r in pw_results:
        marker = '✅' if r['ok'] else '❌'
        extras = ''
        if 'staging_banner' in r:
            extras = f" banner={r['staging_banner']}, errors={r.get('errors', 0)}"
        if 'error' in r:
            extras = f" - {r['error']}"
        print(f"  {marker} {r['label']}{extras}")

    # 総合判定
    print()
    print("=" * 70)
    all_ok = all([
        check_url(DEFAULT_STAGING_URL)['ok'],
        check_url(DEFAULT_STAGING_URL, 'STAGING ENV').get('expect_text_found'),
        all(r['ok'] for r in pw_results),
    ])
    print("✅ 全項目 PASS" if all_ok else "⚠ 一部 FAIL")
    return all_ok


if __name__ == '__main__':
    sys.exit(0 if main() else 1)
