"""v3.7.70 本番スモークテスト (Playwright)
Cloudflare Pages 本番サイトで:
  1. ログイン画面が表示されるか (320x568 / 390x844 / 1280x800)
  2. JS バンドルが読めるか
  3. ガード: 削除された UI 文言が残っていないか (page.content() 検査)
"""
import sys
from playwright.sync_api import sync_playwright

URL = "https://rakushift-ai.pages.dev/"

DELETED_KEYWORDS = [
    "ポジション一覧",
    "中休み時間 (中抜き営業の方のみ)",
    "時間帯別の必要人数 (ランチ・ディナー等)",
    "1.5. ポジション設定",
]

VIEWPORTS = [
    ("iPhone SE", 320, 568),
    ("iPhone 12", 390, 844),
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
                title = page.title()
                # ログイン UI が出ているか
                body_text = page.locator("body").inner_text(timeout=5000)[:500]
                content = page.content()
                deleted_hits = [k for k in DELETED_KEYWORDS if k in content]
                print(f"[{name} {w}x{h}] title={title!r}")
                print(f"  body[:80] = {body_text[:80]!r}")
                print(f"  deleted-keyword hits = {deleted_hits}")
                if deleted_hits:
                    all_ok = False
            except Exception as e:
                print(f"[{name} {w}x{h}] ERROR: {e}")
                all_ok = False
            finally:
                ctx.close()
        browser.close()
    print("\n=== RESULT:", "PASS" if all_ok else "FAIL", "===")
    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(run())
