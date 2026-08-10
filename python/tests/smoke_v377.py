"""v3.7.77 本番反映確認 (Playwright)"""
import sys
from playwright.sync_api import sync_playwright

URL = "https://rakushift-ai.pages.dev/"

KEYWORDS = [
    "シフトパターン別 月間目標回数",
    "staffPatternTargetsContainer",
    "setting-staff-pattern-target",
    "renderStaffPatternTargets",
    "pattern_target_counts",
]

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    ctx = browser.new_context(viewport={"width": 1280, "height": 800})
    page = ctx.new_page()
    errors = []
    page.on("console", lambda msg: errors.append(msg.text) if msg.type == "error" else None)
    page.on("pageerror", lambda exc: errors.append(str(exc)))
    page.goto(URL, wait_until="networkidle", timeout=30000)
    page.wait_for_timeout(2000)
    html = page.content()
    print("=== v3.7.77 反映確認 ===")
    for k in KEYWORDS:
        c = html.count(k)
        mark = "✓" if c > 0 else "✗"
        print(f"  {mark} '{k}' = {c} hit")
    js_url = "https://rakushift-ai.pages.dev/js/app_v2.js"
    js = page.evaluate(f"async () => (await fetch('{js_url}')).text()")
    print("\n=== app_v2.js のキーワード ===")
    for k in ("renderStaffPatternTargets", "pattern_target_counts", "setting-staff-pattern-target"):
        c = js.count(k)
        print(f"  {'✓' if c>0 else '✗'} '{k}' = {c} hit")
    print(f"\nブラウザコンソールエラー: {len(errors)} 件")
    for e in errors[:5]:
        print(f"  {e[:200]}")
    browser.close()
