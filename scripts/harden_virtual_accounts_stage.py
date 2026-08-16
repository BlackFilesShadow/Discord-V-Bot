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


def replace_all(path: str, old: str, new: str, expected: int) -> None:
    p = Path(path)
    text = p.read_text(encoding='utf-8')
    count = text.count(old)
    if count == 0 and text.count(new) == expected:
        return
    if count != expected:
        raise SystemExit(f'{path}: expected {expected} markers, found {count}')
    p.write_text(text.replace(old, new), encoding='utf-8')

service = 'src/modules/economy/virtualAccounts.ts'
replace_once(
    service,
    "const IDEMPOTENCY_KEY_MAX = 160;",
    "const IDEMPOTENCY_KEY_MAX = 80;",
)
replace_once(
    service,
    "function assertOperationKey(key: string): void {\n  if (!key || key.length > IDEMPOTENCY_KEY_MAX || /[\\r\\n\\t\\u0000-\\u001f\\u007f]/.test(key)) {\n    throw new Error('Idempotency-Key ungueltig.');\n  }\n}\n",
    "function assertOperationKey(key: string): void {\n  if (!key || key.length > IDEMPOTENCY_KEY_MAX || /[\\r\\n\\t\\u0000-\\u001f\\u007f]/.test(key)) {\n    throw new Error('Idempotency-Key ungueltig.');\n  }\n}\n\nfunction scopedOperationKey(guildId: GuildId, nitradoConnId: NitradoConnId, key: string): string {\n  assertOperationKey(key);\n  return `virtual:${guildId}:${nitradoConnId}:${key}`;\n}\n",
)
replace_all(
    service,
    "  assertOperationKey(args.idempotencyKey);\n  await assertEconomyScopeReady(args.guildId, args.nitradoConnId);",
    "  const operationKey = scopedOperationKey(args.guildId, args.nitradoConnId, args.idempotencyKey);\n  await assertEconomyScopeReady(args.guildId, args.nitradoConnId);",
    2,
)
replace_all(
    service,
    "randomUUID(), args.idempotencyKey, String(args.guildId), String(args.nitradoConnId), args.virtualAccountId,",
    "randomUUID(), operationKey, String(args.guildId), String(args.nitradoConnId), args.virtualAccountId,",
    2,
)
replace_all(
    service,
    "      idempotencyKey: args.idempotencyKey,",
    "      idempotencyKey: operationKey,",
    2,
)
replace_once(
    service,
    "    const code = typeof error === 'object' && error !== null ? (error as { code?: string }).code : undefined;\n    if (code === '23505' || code === 'P2002') throw new Error('Ein virtuelles Konto mit diesem Namen existiert bereits auf diesem Gameserver.');",
    "    const candidate = typeof error === 'object' && error !== null\n      ? error as { code?: string; meta?: { code?: string } }\n      : {};\n    if (candidate.code === '23505' || candidate.code === 'P2002' || candidate.meta?.code === '23505') {\n      throw new Error('Ein virtuelles Konto mit diesem Namen existiert bereits auf diesem Gameserver.');\n    }",
)

route = 'src/dashboard/routes/v2/economyVirtualAccounts.ts'
replace_once(
    route,
    "  const targetPocket: EconomyPocket = body.targetPocket === 'BANK' ? 'BANK' : body.targetPocket === 'WALLET' ? 'WALLET' : 'WALLET';",
    "  let targetPocket: EconomyPocket;\n  if (body.targetPocket === undefined || body.targetPocket === 'WALLET') targetPocket = 'WALLET';\n  else if (body.targetPocket === 'BANK') targetPocket = 'BANK';\n  else { res.status(400).json({ error: 'targetPocket muss WALLET oder BANK sein.' }); return; }",
)

test = 'tests/modules/economyVirtualAccounts.test.ts'
replace_once(
    test,
    "    expect(entry[2]).toBe('discord-virtual-pay:abc');",
    "    expect(entry[2]).toBe(`virtual:${G}:${C}:discord-virtual-pay:abc`);",
)
replace_once(
    test,
    "    expect(ledger[2]).toBe('discord-virtual-pay:abc:user');",
    "    expect(ledger[2]).toBe(`virtual:${G}:${C}:discord-virtual-pay:abc:user`);",
)

safety = 'tests/security/economyVirtualAccountsSafety.test.ts'
replace_once(
    safety,
    "    expect(service).toContain('`${args.idempotencyKey}:user`');",
    "    expect(service).toContain('return `virtual:${guildId}:${nitradoConnId}:${key}`;');\n    expect(service).toContain('`${args.idempotencyKey}:user`');",
)

print('virtual account hardening applied')
