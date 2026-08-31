import { computeEventKey } from '../../src/modules/nitrado/adm/serverLogIngestor';

test('same reused filename and byte offset on another day gets another event key', () => {
  const raw = 'Player "Alpha" (id=abc pos=<1, 2, 3>) has raised Flag_Base on TerritoryFlag at <4, 5, 6>';
  const first = computeEventKey('g', 'c', 'DayZServer.ADM', 42, raw, new Date('2026-08-30T12:00:00.000Z'));
  const replay = computeEventKey('g', 'c', 'DayZServer.ADM', 42, raw, new Date('2026-08-30T12:00:00.000Z'));
  const nextDay = computeEventKey('g', 'c', 'DayZServer.ADM', 42, raw, new Date('2026-08-31T12:00:00.000Z'));
  expect(replay).toBe(first);
  expect(nextDay).not.toBe(first);
});
