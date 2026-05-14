import os
import re

print("Starting safe deep debug fixes for app_v2.js...")

app_js_path = r'f:\ラクシフト\js\app_v2.js'
with open(app_js_path, 'r', encoding='utf-8') as f:
    app_content = f.read()

# XSS mitigation for map(s => ... ${s.name} ...)
app_content = re.sub(
    r'\$\{\s*(s\.name|r\.name|staff\.name|user\.name)\s*\}',
    r'${this._sanitize(\1)}',
    app_content
)

# Safe Null checks for getElementById().value
# Only replace if NOT followed by an assignment operator
app_content = re.sub(
    r"document\.getElementById\('([^']+)'\)\.value(?!\s*=)",
    r"(document.getElementById('\1')?.value || '')",
    app_content
)

app_content = re.sub(
    r'document\.getElementById\("([^"]+)"\)\.value(?!\s*=)',
    r'(document.getElementById("\1")?.value || "")',
    app_content
)

with open(app_js_path, 'w', encoding='utf-8') as f:
    f.write(app_content)

print("[OK] app_v2.js - XSS and missing null checks fixed safely.")
