from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text(encoding='utf-8')
    if new in text:
        return
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: expected exactly one marker, found {count}')
    p.write_text(text.replace(old, new, 1), encoding='utf-8')

replace_once(
    'src/modules/economy/virtualAccounts.ts',
    "export function normalizeVirtualAccountName(input: string): { name: string; nameKey: string } {\n  const name = input.normalize('NFKC').trim().replace(/\\s+/g, ' ');\n  if (name.length < 1 || name.length > VIRTUAL_ACCOUNT_NAME_MAX || /[\\r\\n\\t\\u0000-\\u001f\\u007f]/.test(name)) {\n    throw new Error(`Kontoname muss 1..${VIRTUAL_ACCOUNT_NAME_MAX} druckbare Zeichen enthalten.`);\n  }\n  return { name, nameKey: name.toLowerCase() };\n}",
    "export function normalizeVirtualAccountName(input: string): { name: string; nameKey: string } {\n  const normalized = input.normalize('NFKC');\n  if (/[\\r\\n\\t\\u0000-\\u001f\\u007f]/.test(normalized)) {\n    throw new Error(`Kontoname muss 1..${VIRTUAL_ACCOUNT_NAME_MAX} druckbare Zeichen enthalten.`);\n  }\n  const name = normalized.trim().replace(/\\s+/g, ' ');\n  if (name.length < 1 || name.length > VIRTUAL_ACCOUNT_NAME_MAX) {\n    throw new Error(`Kontoname muss 1..${VIRTUAL_ACCOUNT_NAME_MAX} druckbare Zeichen enthalten.`);\n  }\n  return { name, nameKey: name.toLowerCase() };\n}",
)

replace_once(
    'tests/security/economyVirtualAccountsSafety.test.ts',
    "    expect(schema).toMatch(/model EconomyVirtualAccount \\{[\\s\\S]*?guildId\\s+String[\\s\\S]*?nitradoConnId\\s+String\\b/);\n    expect(schema).toMatch(/model EconomyVirtualAccountEntry \\{[\\s\\S]*?guildId\\s+String[\\s\\S]*?nitradoConnId\\s+String\\b/);\n    expect(schema).not.toMatch(/model EconomyVirtualAccount \\{[\\s\\S]*?nitradoConnId\\s+String\\?/);\n    expect(schema).not.toMatch(/model EconomyVirtualAccountEntry \\{[\\s\\S]*?nitradoConnId\\s+String\\?/);",
    "    expect(schema).toMatch(/model EconomyVirtualAccount \\{[^}]*?guildId\\s+String[^}]*?nitradoConnId\\s+String\\b/s);\n    expect(schema).toMatch(/model EconomyVirtualAccountEntry \\{[^}]*?guildId\\s+String[^}]*?nitradoConnId\\s+String\\b/s);\n    expect(schema).not.toMatch(/model EconomyVirtualAccount \\{[^}]*?nitradoConnId\\s+String\\?/s);\n    expect(schema).not.toMatch(/model EconomyVirtualAccountEntry \\{[^}]*?nitradoConnId\\s+String\\?/s);",
)

print('fixed virtual-account Jest findings')
