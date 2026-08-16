from pathlib import Path
import re

FILES = [
    'src/commands/about.ts',
    'src/commands/user/reminder.ts',
    'src/modules/selfrole/selfRoleMenu.ts',
    'src/commands/user/ai.ts',
    'src/commands/user/poll.ts',
    'src/commands/user/leaderboard.ts',
    'src/modules/tickets/ticketSystem.ts',
    'src/commands/user/giveaway.ts',
    'src/commands/dashboard/economy.ts',
]

for name in FILES:
    p = Path(name)
    s = p.read_text(encoding='utf-8')
    if 'ephemeral: true' not in s:
        continue
    s = s.replace('ephemeral: true', 'flags: MessageFlags.Ephemeral')
    m = re.search(r"import\s*\{([\s\S]*?)\}\s*from\s*'discord\.js';", s)
    if not m:
        raise SystemExit(f'discord.js named import missing: {name}')
    names = m.group(1)
    if 'MessageFlags' not in names:
        if '\n' in names:
            new_names = '\n  MessageFlags,' + names
        else:
            new_names = ' MessageFlags,' + names
        s = s[:m.start(1)] + new_names + s[m.end(1):]
    p.write_text(s, encoding='utf-8')

remaining = []
for p in Path('src').rglob('*.ts'):
    if 'ephemeral: true' in p.read_text(encoding='utf-8'):
        remaining.append(str(p))
if remaining:
    raise SystemExit('remaining deprecated ephemeral options: ' + ', '.join(remaining))
print('remaining discord deprecations fixed')
