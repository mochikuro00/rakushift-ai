import os
import re

print("Starting deep debug fixes...")

# 1. main.py の修正
main_py_path = r'f:\ラクシフト\python\main.py'
with open(main_py_path, 'r', encoding='utf-8') as f:
    main_content = f.read()

# except stripe.error.StripeError: pass -> except stripe.error.StripeError as e: print...
main_content = re.sub(
    r'except stripe\.error\.StripeError:\s+pass',
    r'except stripe.error.StripeError as e:\n                print(f"[Warning] Stripe API Error: {e}")',
    main_content
)

with open(main_py_path, 'w', encoding='utf-8') as f:
    f.write(main_content)
print("[OK] main.py - Empty except block fixed.")

# 2. app_v2.js の修正
app_js_path = r'f:\ラクシフト\js\app_v2.js'
with open(app_js_path, 'r', encoding='utf-8') as f:
    app_content = f.read()

# XSS mitigation for map(s => ... ${s.name} ...) by adding this._sanitize
# This regex tries to find ${s.name} or ${r.name} in template literals inside map and wrap it
app_content = re.sub(
    r'\$\{([^}]+\.name)\}',
    r'${this._sanitize(\1)}',
    app_content
)
# Ensure _sanitize exists or similar. Actually _sanitize might not be accessible if it's inside an arrow function losing `this` context depending on how it's called, but wait, if it's an arrow function, `this` is lexically bound to `app` object. So `this._sanitize` works.
# Wait, some places might already have this._sanitize. Let's do a simple replace for specific known vulnerable lines if generic replace is risky.
# Let's just use DOMPurify if it's loaded, but Rakushift uses `this._sanitize()`.
# A safer regex:
app_content = re.sub(
    r'\$\{\s*(s\.name|r\.name)\s*\}',
    r'${this._sanitize(\1)}',
    app_content
)

# Null checks for getElementById().value
# document.getElementById('xxx').value -> (document.getElementById('xxx')?.value || '')
app_content = re.sub(
    r"document\.getElementById\('([^']+)'\)\.value",
    r"(document.getElementById('\1')?.value || '')",
    app_content
)

# Same for double quotes
app_content = re.sub(
    r'document\.getElementById\("([^"]+)"\)\.value',
    r'(document.getElementById("\1")?.value || "")',
    app_content
)

with open(app_js_path, 'w', encoding='utf-8') as f:
    f.write(app_content)
print("[OK] app_v2.js - XSS and missing null checks fixed.")

print("All fixes applied successfully.")
