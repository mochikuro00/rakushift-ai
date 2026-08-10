"""本番 (Cloudflare Pages) を iPhone SE / iPhone 12 でモバイル確認。"""
from playwright.sync_api import sync_playwright
import os

URL = "https://rakushift-ai.pages.dev/"
OUT_DIR = os.path.join(os.path.dirname(__file__), "mobile_screenshots")
os.makedirs(OUT_DIR, exist_ok=True)

DEVICES = [
    {"name": "iphone_se", "viewport": {"width": 320, "height": 568}, "ua": "Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1"},
    {"name": "iphone_12", "viewport": {"width": 390, "height": 844}, "ua": "Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1"},
]


def inspect_page(page, device_name):
    """ページを検査して問題を報告"""
    issues = []
    # body の overflow チェック (横スクロール発生)
    overflow = page.evaluate("""() => {
        const b = document.body;
        const h = document.documentElement;
        return {
            scrollWidth: Math.max(b.scrollWidth, h.scrollWidth),
            clientWidth: h.clientWidth,
            overflowX: window.getComputedStyle(b).overflowX,
        };
    }""")
    if overflow["scrollWidth"] > overflow["clientWidth"] + 1:
        issues.append(f"⚠ 横スクロール発生: scrollWidth={overflow['scrollWidth']} > clientWidth={overflow['clientWidth']}")

    # ボタン要素の最小タップサイズ確認 (Apple HIG: 44x44 px)
    small_buttons = page.evaluate("""() => {
        const btns = Array.from(document.querySelectorAll('button, a[onclick], [role=button]'));
        const small = [];
        for (const b of btns) {
            const r = b.getBoundingClientRect();
            if (r.width > 0 && r.height > 0 && (r.width < 32 || r.height < 32)) {
                small.push({
                    text: (b.textContent || '').trim().substring(0, 30),
                    w: Math.round(r.width),
                    h: Math.round(r.height),
                });
            }
        }
        return small.slice(0, 5);
    }""")
    if small_buttons:
        issues.append(f"⚠ タップ困難なボタン ({len(small_buttons)}件): {small_buttons[:3]}")

    # フォント小さすぎチェック (12px 未満)
    tiny_text = page.evaluate("""() => {
        const elts = Array.from(document.querySelectorAll('p, div, span, label'));
        let count = 0;
        for (const e of elts) {
            const s = window.getComputedStyle(e);
            const size = parseFloat(s.fontSize);
            if (size < 10 && e.textContent.trim().length > 5) count++;
        }
        return count;
    }""")
    if tiny_text > 5:
        issues.append(f"⚠ 極小フォント (10px未満) 要素 {tiny_text} 個")

    return issues


def main():
    with sync_playwright() as p:
        for dev in DEVICES:
            print(f"\n=== {dev['name'].upper()} ({dev['viewport']['width']}x{dev['viewport']['height']}) ===")
            browser = p.chromium.launch(headless=True)
            ctx = browser.new_context(
                viewport=dev["viewport"],
                user_agent=dev["ua"],
                device_scale_factor=2,
                is_mobile=True,
                has_touch=True,
            )
            page = ctx.new_page()
            page.goto(URL, wait_until="networkidle", timeout=30000)
            page.wait_for_timeout(2000)

            # トップページ
            shot_path = os.path.join(OUT_DIR, f"{dev['name']}_top.png")
            page.screenshot(path=shot_path, full_page=True)
            issues = inspect_page(page, dev["name"])
            print(f"📸 トップ: {shot_path}")
            if issues:
                for i in issues:
                    print(f"  {i}")
            else:
                print("  ✅ 問題なし")

            browser.close()


if __name__ == "__main__":
    main()
