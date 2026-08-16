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
    "function toVirtualEntry(row: DbVirtualEntryRow): VirtualAccountEntryRow {\n  return {\n    ...row,\n    guildId: row.guildId as GuildId,\n    nitradoConnId: row.nitradoConnId as NitradoConnId,\n  };\n}\n",
    "function toVirtualEntry(row: DbVirtualEntryRow): VirtualAccountEntryRow {\n  return {\n    ...row,\n    guildId: row.guildId as GuildId,\n    nitradoConnId: row.nitradoConnId as NitradoConnId,\n  };\n}\n\ninterface ReplayExpectation {\n  guildId: GuildId;\n  nitradoConnId: NitradoConnId;\n  virtualAccountId: string;\n  delta: bigint;\n  entryType: string;\n  sourcePocket: EconomyPocket | null;\n  actorDiscordId: string | null;\n  userDiscordId: string | null;\n  reason: string | null;\n  sourceRef: string | null;\n}\n\nasync function assertReplayMatches(\n  raw: VirtualAccountRawDb,\n  idempotencyKey: string,\n  expected: ReplayExpectation,\n): Promise<void> {\n  const rows = await raw.$queryRawUnsafe<DbVirtualEntryRow[]>(\n    'SELECT \"id\", \"idempotencyKey\", \"guildId\", \"nitradoConnId\", \"virtualAccountId\", \"delta\", \"entryType\", \"sourcePocket\", \"actorDiscordId\", \"userDiscordId\", \"reason\", \"sourceRef\", \"createdAt\" FROM \"EconomyVirtualAccountEntry\" WHERE \"idempotencyKey\"=$1 LIMIT 1',\n    idempotencyKey,\n  );\n  const entry = rows[0];\n  const matches = !!entry\n    && entry.guildId === String(expected.guildId)\n    && entry.nitradoConnId === String(expected.nitradoConnId)\n    && entry.virtualAccountId === expected.virtualAccountId\n    && entry.delta === expected.delta\n    && entry.entryType === expected.entryType\n    && entry.sourcePocket === expected.sourcePocket\n    && entry.actorDiscordId === expected.actorDiscordId\n    && entry.userDiscordId === expected.userDiscordId\n    && entry.reason === expected.reason\n    && entry.sourceRef === expected.sourceRef;\n  if (!matches) throw new Error('Idempotency-Key wurde mit anderen Buchungsdaten wiederverwendet.');\n}\n",
)
replace_once(
    service,
    "    if (claimed !== 1) return { booked: false, account: toVirtualAccount(account) };\n\n    const column = args.sourcePocket === 'WALLET' ? 'walletBalance' : 'bankBalance';",
    "    if (claimed !== 1) {\n      await assertReplayMatches(raw, operationKey, {\n        guildId: args.guildId, nitradoConnId: args.nitradoConnId, virtualAccountId: args.virtualAccountId,\n        delta: args.amount, entryType: 'USER_DEPOSIT', sourcePocket: args.sourcePocket,\n        actorDiscordId: String(args.fromUserId), userDiscordId: String(args.fromUserId), reason,\n        sourceRef: `virtual-account:${args.virtualAccountId}`,\n      });\n      return { booked: false, account: toVirtualAccount(account) };\n    }\n\n    const column = args.sourcePocket === 'WALLET' ? 'walletBalance' : 'bankBalance';",
)
replace_once(
    service,
    "    if (claimed !== 1) return { booked: false, account: toVirtualAccount(account) };\n\n    const sourceRows = await raw.$queryRawUnsafe<DbVirtualAccountRow[]>(",
    "    if (claimed !== 1) {\n      await assertReplayMatches(raw, operationKey, {\n        guildId: args.guildId, nitradoConnId: args.nitradoConnId, virtualAccountId: args.virtualAccountId,\n        delta: -args.amount, entryType: args.entryType ?? 'PAYOUT', sourcePocket: args.targetPocket,\n        actorDiscordId: args.actorDiscordId ? String(args.actorDiscordId) : null, userDiscordId: String(args.toUserId), reason,\n        sourceRef: `virtual-account:${args.virtualAccountId}`,\n      });\n      return { booked: false, account: toVirtualAccount(account) };\n    }\n\n    const sourceRows = await raw.$queryRawUnsafe<DbVirtualAccountRow[]>(",
)

route = 'src/dashboard/routes/v2/economyVirtualAccounts.ts'
replace_once(route, "import { randomUUID } from 'node:crypto';\n", '')
replace_once(
    route,
    "function requestOperationKey(req: EconomyVirtualRequest, prefix: string): string {\n  const raw = req.get('X-Idempotency-Key');\n  const token = raw && raw.length <= 120 && /^[A-Za-z0-9._:-]+$/.test(raw) ? raw : randomUUID();\n  return `${prefix}:${token}`;\n}",
    "function requestOperationKey(req: EconomyVirtualRequest, prefix: string): string {\n  const bodyKey = typeof req.body?.operationId === 'string' ? req.body.operationId : null;\n  const raw = bodyKey ?? req.get('X-Idempotency-Key');\n  if (!raw || raw.length > 120 || !/^[A-Za-z0-9._:-]+$/.test(raw)) {\n    throw new Error('Idempotency-Key fehlt oder ist ungueltig.');\n  }\n  return `${prefix}:${raw}`;\n}",
)

api = 'dashboard-ui/src/lib/api.ts'
replace_once(api, "function uuid(): string {", "export function createIdempotencyKey(): string {")
replace_all(api, "uuid()", "createIdempotencyKey()", 2)

panel = 'dashboard-ui/src/components/economy/VirtualAccountsPanel.tsx'
replace_once(panel, "import { api } from '@/lib/api';", "import { api, createIdempotencyKey } from '@/lib/api';")
replace_once(
    panel,
    "  const [payout, setPayout] = useState({ accountId: '', userDiscordId: '', amount: '', targetPocket: 'WALLET', reason: '' });\n  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);",
    "  const [payout, setPayout] = useState({ accountId: '', userDiscordId: '', amount: '', targetPocket: 'WALLET', reason: '' });\n  const [payoutOperationId, setPayoutOperationId] = useState(createIdempotencyKey);\n  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);\n  const updatePayout = (patch: Partial<typeof payout>) => {\n    setPayout(current => ({ ...current, ...patch }));\n    setPayoutOperationId(createIdempotencyKey());\n  };",
)
replace_once(
    panel,
    "        reason: payout.reason.trim(),\n      },",
    "        reason: payout.reason.trim(),\n        operationId: payoutOperationId,\n      },",
)
replace_once(
    panel,
    "      setPayout({ accountId: '', userDiscordId: '', amount: '', targetPocket: 'WALLET', reason: '' });",
    "      setPayout({ accountId: '', userDiscordId: '', amount: '', targetPocket: 'WALLET', reason: '' });\n      setPayoutOperationId(createIdempotencyKey());",
)
replace_all(panel, "setPayout({ ...payout, accountId: e.target.value })", "updatePayout({ accountId: e.target.value })", 1)
replace_all(panel, "setPayout({ ...payout, userDiscordId: e.target.value.trim() })", "updatePayout({ userDiscordId: e.target.value.trim() })", 1)
replace_all(panel, "setPayout({ ...payout, amount: e.target.value.trim() })", "updatePayout({ amount: e.target.value.trim() })", 1)
replace_all(panel, "setPayout({ ...payout, targetPocket: e.target.value })", "updatePayout({ targetPocket: e.target.value })", 1)
replace_all(panel, "setPayout({ ...payout, reason: e.target.value })", "updatePayout({ reason: e.target.value })", 1)

# Existing duplicate test now needs a matching persisted entry after ON CONFLICT.
test = 'tests/modules/economyVirtualAccounts.test.ts'
replace_once(
    test,
    "  mockQueryRaw.mockImplementation(async (sql: string, ...values: unknown[]) => {\n    if (sql.startsWith('INSERT INTO \"EconomyVirtualAccount\"')) return [baseAccount(0n)];",
    "  mockQueryRaw.mockImplementation(async (sql: string, ...values: unknown[]) => {\n    if (sql.includes('FROM \"EconomyVirtualAccountEntry\" WHERE \"idempotencyKey\"')) return [{\n      id: 'entry-1', idempotencyKey: String(values[0]), guildId: String(G), nitradoConnId: String(C),\n      virtualAccountId: 'virtual-1', delta: 10n, entryType: 'USER_DEPOSIT', sourcePocket: 'WALLET',\n      actorDiscordId: String(U), userDiscordId: String(U), reason: 'Ueberweisung auf virtuelles Konto',\n      sourceRef: 'virtual-account:virtual-1', createdAt: new Date('2026-08-16T10:00:00Z'),\n    }];\n    if (sql.startsWith('INSERT INTO \"EconomyVirtualAccount\"')) return [baseAccount(0n)];",
)
replace_once(
    test,
    "  it('bricht bei fehlender Deckung vor User-Ledger und virtueller Gutschrift ab', async () => {",
    "  it('weist denselben Idempotency-Key mit geaenderten Buchungsdaten hart zurueck', async () => {\n    mockExecuteRaw.mockImplementation(async (sql: string) => sql.startsWith('INSERT INTO \"EconomyVirtualAccountEntry\"') ? 0 : 1);\n    mockQueryRaw.mockImplementation(async (sql: string, ...values: unknown[]) => {\n      if (sql.includes('FROM \"EconomyVirtualAccountEntry\" WHERE \"idempotencyKey\"')) return [{\n        id: 'entry-1', idempotencyKey: String(values[0]), guildId: String(G), nitradoConnId: String(C),\n        virtualAccountId: 'virtual-1', delta: 11n, entryType: 'USER_DEPOSIT', sourcePocket: 'WALLET',\n        actorDiscordId: String(U), userDiscordId: String(U), reason: 'Ueberweisung auf virtuelles Konto',\n        sourceRef: 'virtual-account:virtual-1', createdAt: new Date('2026-08-16T10:00:00Z'),\n      }];\n      if (sql.includes('FROM \"EconomyVirtualAccount\"')) return [baseAccount()];\n      return [];\n    });\n    await expect(transferUserToVirtualAccount({\n      idempotencyKey: 'same-op', guildId: G, nitradoConnId: C,\n      fromUserId: U, virtualAccountId: 'virtual-1', amount: 10n, sourcePocket: 'WALLET',\n    })).rejects.toThrow('anderen Buchungsdaten');\n    expect(sqlCalls('UPDATE \"EconomyAccount\"').filter(([sql]) => String(sql).includes('-$4'))).toHaveLength(0);\n  });\n\n  it('bricht bei fehlender Deckung vor User-Ledger und virtueller Gutschrift ab', async () => {",
)

print('hardened virtual-account retry/idempotency semantics')
