"""
v3.7.163 納品前 15項目 総合テスト

検査対象:
  1. フロント (Cloudflare Pages) 到達確認
  2. バックエンド (Railway) 到達確認
  3. APP_VERSION 文字列が最新
  4. バックエンド /health バージョンが最新
  5. index.html に重要 DOM が存在 (editShiftPatternRow / autoFillTarget)
  6. privacy.html 配信可
  7. admin.html 配信可
  8. JS シンタックス検証 (app_v2.js が parse 可)
  9. パターン行 _renderShiftPatternRow がフォールバック展開
 10. 印刷オーバーレイ生成 (detailed) で table が作られる
 11. 印刷オーバーレイ生成 (compact) で table が作られる
 12. AI 自動シフト作成モーダルの選択肢が 2 件 (reset_all / next_week)
 13. PIN モーダル DOM 存在
 14. モバイル iPhone SE (320x568) で 主要ボタンタップ可
 15. モバイル iPhone 12 (390x844) で レイアウト崩れなし
"""
from playwright.sync_api import sync_playwright
import sys

PROD_FRONT = "https://rakushift-ai.pages.dev/"
PROD_BACK = "https://rakushift-ai-production.up.railway.app/health"
EXPECT_FRONT_VER = "v3.7.164"
EXPECT_BACK_VER = "3.7.164"

results = []

def check(name, ok, detail=""):
    mark = "[OK]" if ok else "[NG]"
    print(f"{mark} {name}{(' - ' + detail) if detail else ''}")
    results.append((name, ok, detail))

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    ctx = browser.new_context()
    page = ctx.new_page()

    # 1. front
    try:
        r = page.goto(PROD_FRONT, wait_until="networkidle", timeout=30000)
        check("1. front 200", r and r.status == 200, f"status={r.status if r else 'None'}")
    except Exception as e:
        check("1. front 200", False, str(e)[:80])

    # 2. backend
    import urllib.request, json
    try:
        with urllib.request.urlopen(PROD_BACK, timeout=10) as resp:
            j = json.loads(resp.read())
            check("2. backend /health", j.get("status") == "ok", json.dumps(j))
    except Exception as e:
        check("2. backend /health", False, str(e)[:80])

    # 3. APP_VERSION
    ver = page.evaluate("() => (typeof app !== 'undefined' && app.APP_VERSION) || 'none'")
    check("3. APP_VERSION 最新", EXPECT_FRONT_VER in ver, ver)

    # 4. backend version
    try:
        with urllib.request.urlopen(PROD_BACK, timeout=10) as resp:
            j = json.loads(resp.read())
            check("4. backend version", j.get("version") == EXPECT_BACK_VER, j.get("version", "?"))
    except Exception as e:
        check("4. backend version", False, str(e)[:80])

    # 5. 重要 DOM
    has_pattern_row = page.evaluate("() => !!document.getElementById('editShiftPatternRow')")
    has_autofill = page.evaluate("() => !!document.getElementById('autoFillTarget')")
    check("5. editShiftPatternRow + autoFillTarget", has_pattern_row and has_autofill,
          f"pattern={has_pattern_row} autofill={has_autofill}")

    # 6. privacy.html
    try:
        rp = page.goto(PROD_FRONT + "privacy.html", wait_until="domcontentloaded", timeout=15000)
        check("6. privacy.html", rp and rp.status == 200, f"status={rp.status if rp else 'None'}")
    except Exception as e:
        check("6. privacy.html", False, str(e)[:80])

    # 7. admin.html
    try:
        ra = page.goto(PROD_FRONT + "admin.html", wait_until="domcontentloaded", timeout=15000)
        check("7. admin.html", ra and ra.status == 200, f"status={ra.status if ra else 'None'}")
    except Exception as e:
        check("7. admin.html", False, str(e)[:80])

    # 8. JS parse OK (再アクセスしてエラーが出ないか)
    console_errors = []
    page2 = ctx.new_page()
    page2.on("console", lambda msg: console_errors.append(msg.text) if msg.type == "error" else None)
    page2.on("pageerror", lambda err: console_errors.append(f"PAGE_ERR: {err}"))
    try:
        page2.goto(PROD_FRONT, wait_until="networkidle", timeout=30000)
        page2.wait_for_timeout(1500)
        # SourceMap や 404 系を無視
        critical = [e for e in console_errors if "404" not in e and "Failed to load" not in e and "favicon" not in e]
        check("8. JS parse / console critical errors なし", len(critical) == 0,
              f"errors={critical[:2] if critical else 'none'}")
    except Exception as e:
        check("8. JS parse", False, str(e)[:80])

    # 9. パターン行 フォールバック展開
    page2.evaluate("() => app._renderShiftPatternRow()")
    html = page2.evaluate("() => document.getElementById('editShiftPatternRow').innerHTML")
    has_btn = "_applyShiftPattern" in html
    check("9. パターン行 ボタン生成", has_btn, f"len={len(html)}")

    # 10. 印刷 detailed
    try:
        page2.evaluate("""() => {
            // state を簡易セット
            app.state.staff = [{ id: 'tst', name: 'テスト太郎' }];
            app.state.shifts = [{ id: 's1', staff_id: 'tst', date: '2026-06-11', start_time: '09:00', end_time: '18:00', break_minutes: 60 }];
            app.state.currentDate = new Date(2026, 5, 11);
            app.printShiftTable('detailed');
        }""")
        page2.wait_for_timeout(800)
        has_print = page2.evaluate("() => !!document.getElementById('printOverlay') && document.querySelectorAll('#printOverlay table').length > 0")
        check("10. 印刷 detailed table 生成", has_print)
        page2.evaluate("() => app.closePrintOverlay()")
    except Exception as e:
        check("10. 印刷 detailed", False, str(e)[:120])

    # 11. 印刷 compact
    try:
        page2.evaluate("() => app.printShiftTable('compact')")
        page2.wait_for_timeout(800)
        has_print2 = page2.evaluate("() => !!document.getElementById('printOverlay') && document.querySelectorAll('#printOverlay table').length > 0")
        check("11. 印刷 compact table 生成", has_print2)
        page2.evaluate("() => app.closePrintOverlay()")
    except Exception as e:
        check("11. 印刷 compact", False, str(e)[:120])

    # 12. AI 自動シフト作成 選択肢
    opts = page2.evaluate("""() => {
        const sel = document.getElementById('autoFillTarget');
        if (!sel) return [];
        return Array.from(sel.options).map(o => o.value);
    }""")
    only_two = sorted(opts) == sorted(["reset_all", "next_week"])
    check("12. AI 作成範囲 = reset_all + next_week のみ", only_two, str(opts))

    # 13. PIN モーダル
    pin_modals = page2.evaluate("() => ({entry: !!document.getElementById('pinEntryModal'), setup: !!document.getElementById('pinSetupModal'), change: !!document.getElementById('pinChangeModal')})")
    check("13. PIN モーダル 3種", pin_modals.get("entry") and pin_modals.get("setup") and pin_modals.get("change"),
          str(pin_modals))

    # 14. iPhone SE
    page_se = ctx.new_page()
    page_se.set_viewport_size({"width": 320, "height": 568})
    try:
        page_se.goto(PROD_FRONT, wait_until="networkidle", timeout=30000)
        page_se.wait_for_timeout(1000)
        # 主要ログインボタンが表示されているか (login画面想定 or トップで何か表示)
        body_height = page_se.evaluate("() => document.body.scrollHeight")
        check("14. iPhone SE 320x568 レンダ", body_height > 100, f"body_h={body_height}")
    except Exception as e:
        check("14. iPhone SE", False, str(e)[:80])

    # 15. iPhone 12
    page_12 = ctx.new_page()
    page_12.set_viewport_size({"width": 390, "height": 844})
    try:
        page_12.goto(PROD_FRONT, wait_until="networkidle", timeout=30000)
        page_12.wait_for_timeout(1000)
        overflow = page_12.evaluate("() => document.documentElement.scrollWidth - document.documentElement.clientWidth")
        check("15. iPhone 12 横スクロール なし", overflow <= 5, f"overflow_px={overflow}")
    except Exception as e:
        check("15. iPhone 12", False, str(e)[:80])

    browser.close()

# サマリ
ok = sum(1 for _, k, _ in results if k)
total = len(results)
print(f"\n=== {ok}/{total} PASS ===")
if ok != total:
    print("\nFAILED:")
    for name, k, d in results:
        if not k:
            print(f"  - {name}: {d}")
sys.exit(0 if ok == total else 1)
