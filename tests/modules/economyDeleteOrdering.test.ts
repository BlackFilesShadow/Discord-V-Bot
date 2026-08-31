import fs from 'node:fs';
import path from 'node:path';

test('virtual account delete commits database state before retiring Discord projection', () => {
  const route = fs.readFileSync(path.resolve(__dirname, '../../src/dashboard/routes/v2/economyVirtualAccountControl.ts'), 'utf8');
  const handlerStart = route.indexOf("delete('/control/accounts/:accountId'");
  const handler = route.slice(handlerStart, route.indexOf("post('/control/accounts/:accountId/sync'", handlerStart));
  expect(handler.indexOf('deleteUnusedVirtualAccount')).toBeGreaterThan(-1);
  expect(handler.indexOf('retireVirtualAccountProjection')).toBeGreaterThan(handler.indexOf('deleteUnusedVirtualAccount'));
});
