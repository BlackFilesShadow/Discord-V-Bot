from pathlib import Path

help_path = Path('src/commands/user/help.ts')
s = help_path.read_text(encoding='utf-8')
s = s.replace(
    "type HelpCategory = 'overview' | 'moderation' | 'nitrado' | 'economy' | 'manufacturer' | 'community';",
    "type HelpCategory = 'overview' | 'moderation' | 'nitrado' | 'economy' | 'manufacturer' | 'community' | 'other';",
    1,
)
s = s.replace(
    "names: new Set(['kick', 'ban', 'mute', 'warn', 'appeal']),",
    "names: new Set(['kick', 'ban', 'mute', 'warn', 'appeal', 'case']),",
    1,
)
s = s.replace(
    "'slot', 'coinflip', 'dice', 'blackjack', 'casino-stats',\n",
    "'slot', 'coinflip', 'dice', 'blackjack', 'casino-stats',\n      'virtual-account', 'lottery', 'black-market',\n",
    1,
)
community_block = """  {\n    id: 'community',\n    label: 'Community & Tools',\n    emoji: '👥',\n    description: 'Polls, Giveaways, Tickets, XP, Fraktionen, Reminder und weitere Nutzerfunktionen.',\n    names: new Set([\n      'help', 'stell-dich-vor', 'feedback', 'erinnerung',\n      'level', 'leaderboard', 'giveaway', 'poll', 'ticket',\n      'fraktionen', 'factions', 'faction', 'join', 'leave',\n    ]),\n  },\n"""
other_block = community_block + """  {\n    id: 'other',\n    label: 'Weitere Funktionen',\n    emoji: '🧭',\n    description: 'Sichtbare Funktionen, die noch keinem festen Bereich zugeordnet sind.',\n    names: new Set(),\n  },\n"""
if community_block not in s:
    raise SystemExit('community block marker missing')
s = s.replace(community_block, other_block, 1)
s = s.replace(
    "return CATEGORIES.find(category => category.names.has(entry.name)) ?? CATEGORIES[CATEGORIES.length - 1];",
    "return CATEGORIES.find(category => category.names.has(entry.name)) ?? CATEGORIES.find(category => category.id === 'other')!;",
    1,
)
s = s.replace(
    "{ name: 'Community & Tools', value: 'community' },\n",
    "{ name: 'Community & Tools', value: 'community' },\n        { name: 'Weitere Funktionen', value: 'other' },\n",
    1,
)
help_path.write_text(s, encoding='utf-8')

inventory_path = Path('src/commands/inventory.ts')
i = inventory_path.read_text(encoding='utf-8')
i = i.replace(
    "'giveaway', 'poll', 'ticket', 'factions', 'balance', 'bank', 'pay', 'transfer', 'virtual-account', 'lottery',",
    "'giveaway', 'poll', 'ticket', 'factions', 'balance', 'bank', 'pay', 'transfer', 'virtual-account', 'lottery', 'black-market',",
    1,
)
i = i.replace(
    "'ai', 'appeal', 'ban', 'kick', 'mute', 'warn', 'download', 'upload',",
    "'ai', 'appeal', 'ban', 'kick', 'mute', 'warn', 'case', 'download', 'upload',",
    1,
)
i = i.replace(
    "'pay', 'slot', 'transfer', 'withdraw', 'virtual-account', 'lottery',",
    "'pay', 'slot', 'transfer', 'withdraw', 'virtual-account', 'lottery', 'black-market',",
    1,
)
inventory_path.write_text(i, encoding='utf-8')
print('help catalog synchronized')
