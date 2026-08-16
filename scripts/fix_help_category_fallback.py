from pathlib import Path
p = Path('src/commands/user/help.ts')
s = p.read_text(encoding='utf-8')
old = "const definition = CATEGORIES.find(item => item.id === category) ?? CATEGORIES[CATEGORIES.length - 1];"
new = "const definition = CATEGORIES.find(item => item.id === category) ?? CATEGORIES.find(item => item.id === 'other')!;"
if old not in s:
    raise SystemExit('emptyCategory fallback marker missing')
p.write_text(s.replace(old, new, 1), encoding='utf-8')
print('explicit help fallback fixed')
