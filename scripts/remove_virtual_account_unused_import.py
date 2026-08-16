from pathlib import Path

path = Path('src/dashboard/routes/v2/economyVirtualAccounts.ts')
text = path.read_text(encoding='utf-8')
needle = "import { randomUUID } from 'node:crypto';\n"
if text.count(needle) != 1:
    raise SystemExit(f'expected exactly one unused randomUUID import, found {text.count(needle)}')
path.write_text(text.replace(needle, '', 1), encoding='utf-8')
print('removed unused randomUUID import')
