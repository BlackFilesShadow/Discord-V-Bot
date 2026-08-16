from pathlib import Path
p = Path('src/modules/economy/lottery.ts')
s = p.read_text(encoding='utf-8')
old = """  } else if (round.status === 'DRAWING') {
    lines.push('🎲 **Ziehung läuft.** Die Runde ist fuer neue Kaeufe geschlossen.');
"""
new = """  } else if (round.status === 'ACTIVE') {
    lines.push('⏳ **Teilnahme beendet. Die Auswertung läuft.**');
    lines.push('Neue Ticketkäufe sind geschlossen; Ziehung oder Refund wird automatisch verarbeitet.');
  } else if (round.status === 'DRAWING') {
    lines.push('🎲 **Ziehung läuft.** Die Runde ist fuer neue Kaeufe geschlossen.');
"""
if old not in s:
    raise SystemExit('expired ACTIVE embed marker missing')
p.write_text(s.replace(old, new, 1), encoding='utf-8')

p = Path('tests/security/economyLotteryIntegration.test.ts')
t = p.read_text(encoding='utf-8')
old = "    expect(lottery).toContain('nameKey: potName.toLowerCase()');\n"
new = "    expect(lottery).toContain('nameKey: potName.toLowerCase()');\n    expect(lottery).toContain('Teilnahme beendet. Die Auswertung läuft.');\n"
if old not in t:
    raise SystemExit('integration test marker missing')
p.write_text(t.replace(old, new, 1), encoding='utf-8')
print('expired ACTIVE lottery embed fixed')