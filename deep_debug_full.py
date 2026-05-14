import os
import re
from collections import Counter
import ast

def scan_python_file(filepath):
    issues = []
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()
        lines = content.split('\n')
        
    try:
        tree = ast.parse(content)
        for node in ast.walk(tree):
            if isinstance(node, ast.ExceptHandler):
                if not node.body or (len(node.body) == 1 and isinstance(node.body[0], ast.Pass)):
                    issues.append(f"L{node.lineno}: Empty except block (silencing errors)")
    except SyntaxError as e:
        issues.append(f"Syntax Error: {e}")
        
    for i, line in enumerate(lines):
        if 'print(' in line:
            if any(w in line.lower() for w in ['password', 'secret', 'token', 'key']):
                issues.append(f"L{i+1}: Print statement with potentially sensitive data")
        if re.search(r'/\s*0', line):
            issues.append(f"L{i+1}: Potential division by zero")
        if 'timeLimit' in line and 'pulp' in content:
             # Just checking if solver has timeLimit
             pass
    return issues

def scan_js_file(filepath):
    issues = []
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()
        lines = content.split('\n')
        
    for i, line in enumerate(lines):
        if 'console.log' in line:
            if any(w in line.lower() for w in ['password', 'secret', 'token', 'key', 'apikey', 'auth']):
                issues.append(f"L{i+1}: console.log with potentially sensitive data")
        if '.innerHTML' in line and '=' in line and 'DOMPurify' not in line and '_sanitize' not in line and 'sanitize' not in line:
             if re.search(r'\+|=.*(user|data|val|input)', line, re.IGNORECASE):
                issues.append(f"L{i+1}: Potential XSS via innerHTML without apparent sanitization")
        if '.value' in line and 'getElementById(' in line and '?' not in line:
            if '=' in line and line.find('.value') > line.find('='):
                 issues.append(f"L{i+1}: Missing null check for getElementById.value")
        if 'await ' in line and '.catch(' not in line:
             # Very basic heuristic
             pass
        if 'TODO' in line or 'FIXME' in line:
             issues.append(f"L{i+1}: Unresolved TODO/FIXME: {line.strip()}")
    return issues

def scan_html_file(filepath):
    issues = []
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()
        
    id_pattern = re.compile(r'id="([^"]+)"')
    all_ids = id_pattern.findall(content)
    id_counts = Counter(all_ids)
    for id_name, count in id_counts.items():
        if count > 1 and id_name not in ['']:
            issues.append(f"Duplicate ID '{id_name}' found {count} times")
            
    if 'http://' in content and 'http://localhost' not in content:
        issues.append(f"Potential Mixed Content: found 'http://' URLs")
    return issues

def scan_directory(base_dir):
    report = {}
    for root, _, files in os.walk(base_dir):
        if 'node_modules' in root or '.git' in root or '.gemini' in root:
            continue
        for file in files:
            filepath = os.path.join(root, file)
            issues = []
            if file.endswith('.py'):
                issues = scan_python_file(filepath)
            elif file.endswith('.js') or file.endswith('.jsx'):
                issues = scan_js_file(filepath)
            elif file.endswith('.html'):
                issues = scan_html_file(filepath)
                
            if issues:
                report[filepath] = issues
    return report

if __name__ == "__main__":
    report = scan_directory(r'f:\ラクシフト')
    total_issues = sum(len(v) for v in report.values())
    print(f"=== Deep Debug Scan Report: {total_issues} issues found ===")
    for filepath, issues in report.items():
        print(f"\n[{filepath}]")
        for issue in issues:
            print(f"  - {issue}")
