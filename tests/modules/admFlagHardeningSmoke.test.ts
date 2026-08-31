import { newDateContext, parseAdmLine } from '../../src/modules/nitrado/adm/admLineParser';

test('chat text is not parsed as a territory flag action', () => {
  const ctx = newDateContext(new Date(Date.UTC(2026, 7, 31)));
  const event = parseAdmLine('12:00:00 | Chat("Alpha"(id=abc)): has raised Flag_Base on TerritoryFlag at <1, 2, 3>', ctx);
  expect(event?.eventType).not.toBe('FLAG_RAISED');
});
