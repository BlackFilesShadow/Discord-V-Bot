import fs from 'node:fs';
import path from 'node:path';

test('confirmed market mutations start Discord sync immediately', () => {
  const route = fs.readFileSync(path.resolve(__dirname, '../../src/dashboard/routes/v2/economyBlackMarket.ts'), 'utf8');
  expect(route).toContain('const syncWarning = await immediateMarketSync(req)');
  expect(route).toContain('const [marketWarning, virtualWarning] = await Promise.all([');
  expect(route).toContain('syncMarketDiscordProjection');
  expect(route).toContain('syncVirtualAccountProjection');
});
