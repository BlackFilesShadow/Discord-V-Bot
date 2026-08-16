from pathlib import Path

p = Path('tests/modules/selfRoleMenu.roles.test.ts')
s = p.read_text(encoding='utf-8')
s = s.replace("import { handleSelfRoleButton } from '../../src/modules/selfrole/selfRoleMenu';", "import { MessageFlags } from 'discord.js';\nimport { handleSelfRoleButton } from '../../src/modules/selfrole/selfRoleMenu';", 1)
s = s.replace("const arg = reply.mock.calls[0][0] as { embeds: Array<{ data: { description?: string } }>; ephemeral?: boolean };\n  expect(arg.ephemeral).toBe(true);", "const arg = reply.mock.calls[0][0] as { embeds: Array<{ data: { description?: string } }>; flags?: number };\n  expect(arg.flags).toBe(MessageFlags.Ephemeral);", 1)
p.write_text(s, encoding='utf-8')

p = Path('tests/modules/selfRoleMenu.optionBehavior.test.ts')
s = p.read_text(encoding='utf-8')
s = s.replace("import {\n  buildMenuRows,", "import { MessageFlags } from 'discord.js';\nimport {\n  buildMenuRows,", 1)
s = s.replace("const response = reply.mock.calls[0][0] as { embeds: Array<{ data: { description?: string } }>; ephemeral: boolean };\n    expect(response.ephemeral).toBe(true);", "const response = reply.mock.calls[0][0] as { embeds: Array<{ data: { description?: string } }>; flags?: number };\n    expect(response.flags).toBe(MessageFlags.Ephemeral);", 1)
s = s.replace("const feedback = followUp.mock.calls[0][0] as { embeds?: unknown[]; ephemeral?: boolean };\n    expect(feedback.ephemeral).toBe(true);", "const feedback = followUp.mock.calls[0][0] as { embeds?: unknown[]; flags?: number };\n    expect(feedback.flags).toBe(MessageFlags.Ephemeral);", 1)
p.write_text(s, encoding='utf-8')

for path in ['tests/modules/selfRoleMenu.roles.test.ts', 'tests/modules/selfRoleMenu.optionBehavior.test.ts']:
    text = Path(path).read_text(encoding='utf-8')
    if 'MessageFlags.Ephemeral' not in text:
        raise SystemExit(f'MessageFlags assertion missing: {path}')
    if 'expect(arg.ephemeral).toBe(true)' in text or 'expect(response.ephemeral).toBe(true)' in text or 'expect(feedback.ephemeral).toBe(true)' in text:
        raise SystemExit(f'stale ephemeral assertion remains: {path}')
print('self-role tests aligned with MessageFlags.Ephemeral')
