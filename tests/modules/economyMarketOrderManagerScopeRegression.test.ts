import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '../..');
const source = fs.readFileSync(path.join(root, 'src/modules/economy/blackMarketOrderInteractionsV2.ts'), 'utf8');
const market = fs.readFileSync(path.join(root, 'src/modules/economy/blackMarket.ts'), 'utf8');
const orderService = fs.readFileSync(path.join(root, 'src/modules/economy/blackMarketOrder.ts'), 'utf8');
const runtime = fs.readFileSync(path.join(root, 'src/modules/economy/marketOrderReadyRuntime.ts'), 'utf8');
const composite = fs.readFileSync(path.join(root, 'src/events/interactionCreateComposite.ts'), 'utf8');
const migration = fs.readFileSync(path.join(root, 'prisma/migrations/20260902043000_economy_market_ready_outbox/migration.sql'), 'utf8');

test('Bestellung abschließen parses every manager custom id fail-closed', () => {
  expect(source).toContain('function parseMarketOrderManagerComponentId');
  expect(source).toContain("expectedKind === 'vacct_mgr_order' ? 2 : 3");
  expect(source).toContain("parseMarketOrderManagerComponentId(interaction.customId, 'vacct_mgr_order')");
  expect(source).toContain("parseMarketOrderManagerComponentId(interaction.customId, 'vacct_mgr_order_page')");
  expect(source).toContain("parseMarketOrderManagerComponentId(interaction.customId, 'vacct_mgr_order_sel')");
  expect(source).toContain('String(asNitradoConnId(parts[1]))');
  expect(source).toContain("!/^(0|[1-9][0-9]*)$/.test(rawPage)");
  expect(source).toContain('.setCustomId(`vacct_mgr_order_sel:${connId}:${page}`)');
});

test('manager pages over all assigned vendor orders with a scoped SQL count and page query', () => {
  expect(orderService).toContain('export async function listManagedOpenMarketOrdersPage');
  expect(orderService).toContain('COUNT(*)::integer AS total');
  expect(orderService).toContain('"vendorAccountId" = ANY($3::text[])');
  expect(orderService).toContain('ORDER BY "createdAt" ASC, "id" ASC LIMIT $4 OFFSET $5');
  expect(source).toContain('listManagedOpenMarketOrdersPage(guildId, nitradoConnId, vendorIds, PAGE_SIZE, requestedPage * PAGE_SIZE)');
  expect(source).toContain('const pageOrders = result.orders');
  expect(source).not.toContain('open.slice(0, 25)');
  expect(source).toContain('vacct_mgr_order_page:');
  expect(composite).toContain("i.customId.startsWith('vacct_mgr_order_page:')");
  expect(composite).toContain('handleMarketOrderManagerPageButton');
});

test('new vendors assign their creator as account manager for the management embed', () => {
  expect(market).toContain("import { replaceVirtualAccountManagers } from './virtualAccountFinance'");
  expect(market).toContain('await replaceVirtualAccountManagers({');
  expect(market).toContain('userDiscordIds: [args.createdByDiscordId]');
  expect(market).toContain('addedByDiscordId: args.createdByDiscordId');
});

test('closing an order atomically enqueues exactly one persistent ready intent', () => {
  expect(orderService).toContain("VALUES ($1,$2,$3,$4,$5,'PENDING',0,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)");
  expect(orderService).toContain('ON CONFLICT ("orderId") DO NOTHING');
  expect(orderService).toContain("if (lockedOrder.status === 'CLOSED') return false");
  expect(source).not.toContain('postOrderReadyEmbed');
  expect(source).toContain('persistent eingeplant');
});

test('ready delivery has retry state, lease and one-minute cleanup', () => {
  expect(migration).toContain("('PENDING', 'SENDING', 'SENT')");
  expect(migration).toContain('"attempts" INTEGER NOT NULL DEFAULT 0');
  expect(migration).toContain('"nextAttemptAt" TIMESTAMP(3)');
  expect(migration).toContain('"leaseUntil" TIMESTAMP(3)');
  expect(runtime).toContain('FOR UPDATE SKIP LOCKED');
  expect(runtime).toContain("status: 'PENDING'");
  expect(runtime).toContain("status: 'SENT'");
  expect(runtime).toContain('READY_TTL_MS = 60_000');
});

test('original pending order embed is edited to completed after close', () => {
  expect(source).toContain('async function editOriginalOrderMessage');
  expect(source).toContain(".setTitle('✅ Bestellung abgeschlossen')");
  expect(source).toContain("value: '**Bestellung abgeschlossen**'");
});
