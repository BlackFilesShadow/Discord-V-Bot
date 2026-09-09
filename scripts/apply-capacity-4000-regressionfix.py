from pathlib import Path

# Full-suite compatibility for intentional capacity changes. These assertions
# verify the hardened semantics instead of the removed population prefixes / old
# Prisma object-query spelling.

whitelist_test = Path('tests/modules/nitradoWhitelistIntent.test.ts')
text = whitelist_test.read_text(encoding='utf-8')
old = """    expect(deletionRequestFindMany).toHaveBeenCalledWith({
      where: {
        requestType: 'PARTIAL_DELETION',
        status: 'IN_PROGRESS',
        details: { path: ['guildId'], equals: GUILD },
      },
      select: { discordId: true, details: true },
      take: 500,
    });"""
new = """    expect(deletionRequestFindMany).toHaveBeenCalledWith({
      where: {
        requestType: 'PARTIAL_DELETION',
        status: 'IN_PROGRESS',
        details: { path: ['guildId'], equals: GUILD },
      },
      select: { discordId: true, details: true },
    });"""
if new not in text:
    if old not in text:
        raise SystemExit('whitelist intent stale take:500 assertion anchor missing')
    text = text.replace(old, new, 1)
whitelist_test.write_text(text, encoding='utf-8')

runtime_test = Path('tests/runtime/gameplayFeedActivationPacingGate.test.ts')
text = runtime_test.read_text(encoding='utf-8')
replacements = [
    (
        "    expect(runtime).toContain('sourceFile: latestCursor.fileIdentity');",
        "    expect(runtime).toContain('AND \"sourceFile\" = ${latestCursor.fileIdentity}');",
        'gameplay feed stale sourceFile assertion anchor missing',
    ),
    (
        "    expect(runtime).toContain('AdmEventType.PLAYER_CONNECTED');",
        "    expect(runtime).toContain(\"'PLAYER_CONNECTED'::\\\"AdmEventType\\\"\");",
        'gameplay feed stale PLAYER_CONNECTED assertion anchor missing',
    ),
    (
        "    expect(runtime).toContain('AdmEventType.PLAYER_DISCONNECTED');",
        "    expect(runtime).toContain(\"'PLAYER_DISCONNECTED'::\\\"AdmEventType\\\"\");",
        'gameplay feed stale PLAYER_DISCONNECTED assertion anchor missing',
    ),
    (
        "    expect(runtime).toContain('AdmEventType.PLAYER_POSITION');",
        "    expect(runtime).toContain(\"'PLAYER_POSITION'::\\\"AdmEventType\\\"\");",
        'gameplay feed stale PLAYER_POSITION assertion anchor missing',
    ),
]
for old, new, error in replacements:
    if new not in text:
        if old not in text:
            raise SystemExit(error)
        text = text.replace(old, new, 1)
runtime_test.write_text(text, encoding='utf-8')
