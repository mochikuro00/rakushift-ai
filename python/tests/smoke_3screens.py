"""3画面 (店舗用 / 本部統括 / 運営管理) シミュレーション
v3.7.129 本番動作確認用

各画面で確認するもの:
1. ページがロードできる (HTTP 200)
2. JavaScript エラーが出ない
3. 主要 UI 要素が存在する (ログインボタン、入力欄等)
4. レスポンシブ (デスクトップ + モバイル)
"""
import sys
from playwright.sync_api import sync_playwright

BASE = "https://rakushift-ai.pages.dev"

SCREENS = [
    {
        'name': '店舗用 (一般)',
        'url': f"{BASE}/",
        'expect_keywords': ['ラクシフト', 'ログイン', '店舗'],
    },
    {
        'name': '本部統括',
        'url': f"{BASE}/?as_hq=1",  # HQ モードのクエリ
        'expect_keywords': ['ラクシフト'],
    },
    {
        'name': '運営管理',
        'url': f"{BASE}/admin.html",
        'expect_keywords': ['admin', '管理', 'ログイン'],
    },
]

VIEWPORTS = [
    {'name': 'Desktop', 'w': 1280, 'h': 800},
    {'name': 'iPhone 12', 'w': 390, 'h': 844},
]


def check_screen(p, screen, vp):
    """1画面 × 1ビューポート の検証"""
    label = f"[{screen['name']}] {vp['name']} ({vp['w']}x{vp['h']})"
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': vp['w'], 'height': vp['h']})
    errors = []
    page.on('console', lambda msg: errors.append(msg.text) if msg.type == 'error' else None)
    page.on('pageerror', lambda err: errors.append(f'PAGE: {err}'))
    try:
        resp = page.goto(screen['url'], wait_until='networkidle', timeout=30000)
        status = resp.status if resp else 0
    except Exception as e:
        browser.close()
        return {'label': label, 'ok': False, 'reason': f'load failed: {e}'}

    if status != 200:
        browser.close()
        return {'label': label, 'ok': False, 'reason': f'HTTP {status}'}

    title = page.title()
    body_text = page.locator('body').inner_text()[:500]
    buttons = page.locator('button:visible').count()
    inputs = page.locator('input:visible').count()

    # コンソールエラー
    if errors:
        browser.close()
        return {
            'label': label, 'ok': False,
            'reason': f'{len(errors)} console errors: {errors[0][:100]}',
            'title': title,
        }

    # 期待キーワード
    found = sum(1 for kw in screen['expect_keywords'] if kw in body_text or kw in title)
    keyword_ok = found > 0

    # 小タップ要素 (モバイルのみ)
    small_taps = 0
    if vp['w'] < 600:
        small_taps = page.evaluate("""
            () => {
                const els = document.querySelectorAll('button:not(.hidden), a:not(.hidden), [role="button"]');
                let c = 0;
                els.forEach(el => {
                    if (el.offsetParent === null) return;
                    const r = el.getBoundingClientRect();
                    if (r.width > 0 && r.height > 0 && (r.width < 38 || r.height < 38)) c++;
                });
                return c;
            }
        """)

    browser.close()
    return {
        'label': label,
        'ok': keyword_ok and len(errors) == 0,
        'title': title,
        'buttons': buttons,
        'inputs': inputs,
        'errors': len(errors),
        'small_taps': small_taps,
        'keyword_found': f'{found}/{len(screen["expect_keywords"])}',
    }


def main():
    results = []
    print("=" * 70)
    print("3画面シミュレーション (v3.7.129)")
    print("=" * 70)
    with sync_playwright() as p:
        for screen in SCREENS:
            print(f"\n--- {screen['name']} ({screen['url']}) ---")
            for vp in VIEWPORTS:
                r = check_screen(p, screen, vp)
                results.append(r)
                marker = '✅' if r['ok'] else '❌'
                print(f"  {marker} {vp['name']}: ", end='')
                if r['ok']:
                    print(f"title='{r.get('title','')[:30]}', btn={r.get('buttons',0)}, "
                          f"input={r.get('inputs',0)}, smalltap={r.get('small_taps','-')}, "
                          f"kw={r.get('keyword_found','')}")
                else:
                    print(f"NG - {r.get('reason', 'unknown')}")

    print()
    print("=" * 70)
    ok_count = sum(1 for r in results if r['ok'])
    print(f"【総合】 {ok_count}/{len(results)} PASS")
    if ok_count == len(results):
        print("✅ 全画面 全ビューポート 動作確認 OK")
        return True
    else:
        print("⚠ 一部画面でエラー")
        for r in results:
            if not r['ok']:
                print(f"  - {r['label']}: {r.get('reason', '')}")
        return False


if __name__ == '__main__':
    ok = main()
    sys.exit(0 if ok else 1)
