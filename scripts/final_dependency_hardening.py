import json
from pathlib import Path

root = Path('package.json')
pkg = json.loads(root.read_text(encoding='utf-8'))
deps = pkg['dependencies']
for name in ['uuid', 'passport', 'passport-discord']:
    deps.pop(name, None)
deps['fast-xml-parser'] = '^5.11.0'
deps['multer'] = '^2.2.0'
for name in ['@types/passport', '@types/passport-discord']:
    pkg['devDependencies'].pop(name, None)
root.write_text(json.dumps(pkg, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')

dash = Path('dashboard-ui/package.json')
dpkg = json.loads(dash.read_text(encoding='utf-8'))
dpkg['dependencies']['react-router-dom'] = '^7.18.0'
dash.write_text(json.dumps(dpkg, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')

ci = Path('.github/workflows/ci.yml')
s = ci.read_text(encoding='utf-8')
old = '''      - name: Root npm audit (critical blocking)\n        run: npm audit --audit-level=critical\n      - name: Root npm audit (high - report only)\n        run: npm audit --audit-level=high\n        continue-on-error: true\n\n      - name: Dashboard production audit (high blocking)\n'''
new = '''      - name: Root npm audit (critical blocking)\n        run: npm audit --audit-level=critical\n      - name: Root production audit (high blocking)\n        run: npm audit --omit=dev --audit-level=high\n      - name: Root full audit (high - report only)\n        run: npm audit --audit-level=high\n        continue-on-error: true\n\n      - name: Dashboard production audit (high blocking)\n'''
if old not in s:
    raise SystemExit('CI audit marker missing')
ci.write_text(s.replace(old, new, 1), encoding='utf-8')
print('dependency and audit policy hardening applied')
