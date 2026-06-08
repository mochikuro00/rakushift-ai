"""ブラウザコンソールエラー検査"""
import sys
from playwright.sync_api import sync_playwright

URL = "https://rakushift-ai.pages.dev/"

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    ctx = browser.new_context(viewport={"width": 1280, "height": 800})
    page = ctx.new_page()
    errors = []
    warnings = []
    page.on("console", lambda msg: (
        errors.append((msg.type, msg.text)) if msg.type == "error"
        else warnings.append((msg.type, msg.text)) if msg.type == "warning"
        else None
    ))
    page.on("pageerror", lambda exc: errors.append(("pageerror", str(exc))))
    try:
        page.goto(URL, wait_until="networkidle", timeout=30000)
        page.wait_for_timeout(3000)  # 遅延スクリプト含めて 3秒待つ
    except Exception as e:
        print(f"navigation failed: {e}")
        sys.exit(1)
    print(f"=== Errors ({len(errors)}) ===")
    for t, msg in errors[:20]:
        print(f"  [{t}] {msg[:300]}")
    print(f"\n=== Warnings ({len(warnings)}) ===")
    for t, msg in warnings[:20]:
        print(f"  [{t}] {msg[:200]}")
    browser.close()
    sys.exit(0 if len(errors) == 0 else 1)
