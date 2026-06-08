"""タップ可能要素の詳細を確認"""
import sys
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    ctx = browser.new_context(viewport={"width": 390, "height": 844})
    page = ctx.new_page()
    page.goto("https://rakushift-ai.pages.dev/", wait_until="networkidle", timeout=30000)
    tiny = page.evaluate("""() => {
        const btns = Array.from(document.querySelectorAll('button, input[type="submit"], a'));
        const small = btns.filter(b => {
            const r = b.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && (r.width < 32 || r.height < 32);
        }).map(b => {
            const r = b.getBoundingClientRect();
            return {
                tag: b.tagName,
                text: (b.innerText || b.value || b.getAttribute('aria-label') || b.title || '').trim().slice(0,40),
                w: Math.round(r.width),
                h: Math.round(r.height),
                visible: r.width > 0 && r.height > 0 && b.offsetParent !== null,
            };
        });
        return small;
    }""")
    for t in tiny:
        print(f"  {t['tag']:6s} {t['w']}x{t['h']:2d}px visible={t['visible']} text={t['text']!r}")
    browser.close()
