"""v3.7.75 レスポンシブ確認テスト"""
import sys
from playwright.sync_api import sync_playwright

URL = "https://rakushift-ai.pages.dev/"

VIEWPORTS = [
    ("iPhone SE", 320, 568),
    ("iPhone 12", 390, 844),
    ("iPad", 768, 1024),
    ("Desktop", 1280, 800),
]


def run():
    all_ok = True
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        for name, w, h in VIEWPORTS:
            ctx = browser.new_context(viewport={"width": w, "height": h})
            page = ctx.new_page()
            try:
                page.goto(URL, wait_until="networkidle", timeout=30000)
                # ボディサイズと横スクロール量を計測
                metrics = page.evaluate("""() => {
                    return {
                        bodyW: document.body.scrollWidth,
                        viewW: window.innerWidth,
                        bodyH: document.body.scrollHeight,
                        viewH: window.innerHeight,
                    };
                }""")
                horizontal_overflow = metrics["bodyW"] > metrics["viewW"] + 2
                # 主要ボタンのタップ可能サイズを確認
                tap_targets = page.evaluate("""() => {
                    const btns = Array.from(document.querySelectorAll('button, input[type="submit"], a'));
                    const tiny = btns.filter(b => {
                        const r = b.getBoundingClientRect();
                        return r.width > 0 && r.height > 0 && (r.width < 32 || r.height < 32);
                    }).length;
                    return { total: btns.length, tiny };
                }""")
                title = page.title()
                print(f"[{name} {w}x{h}]")
                print(f"  title           = {title!r}")
                print(f"  body            = {metrics['bodyW']}x{metrics['bodyH']}")
                print(f"  viewport        = {metrics['viewW']}x{metrics['viewH']}")
                print(f"  horizontal scroll = {'⚠ YES' if horizontal_overflow else '✓ NO'}")
                print(f"  tappable buttons = {tap_targets['total']} total, {tap_targets['tiny']} too-small (<32px)")
                # iPhone SE 等のモバイル幅で小さすぎるボタンが10個以上あれば WARN
                if w <= 390 and tap_targets["tiny"] > 10:
                    print(f"  ⚠ too many small targets on mobile")
                    all_ok = False
                if horizontal_overflow:
                    print(f"  ⚠ horizontal overflow detected")
                    all_ok = False
            except Exception as e:
                print(f"[{name} {w}x{h}] ERROR: {e}")
                all_ok = False
            finally:
                ctx.close()
        browser.close()
    print("\n=== RESPONSIVE RESULT:", "PASS" if all_ok else "FAIL", "===")
    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(run())
