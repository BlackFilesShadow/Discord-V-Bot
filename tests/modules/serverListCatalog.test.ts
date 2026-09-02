import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '../..');
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');

describe('server list catalog', () => {
  const catalog = read('src/modules/nitrado/serverListCatalog.ts');
  const runtime = read('src/modules/nitrado/runtime.ts');
  const composite = read('src/events/interactionCreateComposite.ts');
  const whitelistRoute = read('src/dashboard/routes/v2/whitelist.ts');
  const migration = read('prisma/migrations/20260901120000_server_list_catalog_channels/migration.sql');

  it('persists separate whitelist and ban catalog anchors per guild and gameserver', () => {
    expect(migration).toContain('"whitelistCatalogChannelId"');
    expect(migration).toContain('"whitelistCatalogMessageId"');
    expect(migration).toContain('"banCatalogChannelId"');
    expect(migration).toContain('"banCatalogMessageId"');
    expect(catalog).toContain('guildId_nitradoConnId');
    expect(catalog).toContain('whitelistCatalogChannelId');
    expect(catalog).toContain('banCatalogChannelId');
  });

  it('keeps Nitrado as the authoritative refresh source every three minutes', () => {
    expect(catalog).toContain('const SYNC_INTERVAL_MS = 3 * 60_000');
    expect(catalog).toContain('client.getWhitelist');
    expect(catalog).toContain('client.getBanlist');
    expect(catalog).toContain('const catalogReads = new Map<string, Promise<string[]>>()');
    expect(catalog).toContain('if (activeRead) return activeRead');
    expect(catalog).toContain('void syncConfiguredCatalogs(client)');
    expect(runtime).toContain('startServerListCatalogSync(client)');
    expect(runtime).toContain('stopServerListCatalogSync()');
  });

  it('uses fixed public embeds with arrows, refresh and modal search', () => {
    expect(catalog).toContain('const PAGE_SIZE = 20');
    expect(catalog).toContain("setLabel('◀')");
    expect(catalog).toContain("setLabel('▶')");
    expect(catalog).toContain("setLabel('Suchen')");
    expect(catalog).toContain("setLabel('Aktualisieren')");
    expect(catalog).toContain('new ModalBuilder()');
    expect(composite).toContain("i.customId.startsWith('listcat:')");
    expect(composite).toContain("i.customId.startsWith('listcat_search:')");
  });

  it('keeps normal page navigation on a strict zero-IO hot path', () => {
    expect(catalog).toContain('const catalogStates = new Map<string, CatalogState>()');
    const marker = '// Hot path: RAM state -> one Discord interaction update.';
    const hotPath = catalog.slice(catalog.indexOf(marker), catalog.indexOf('export async function handleServerListCatalogSearch'));
    expect(hotPath).toContain('await interaction.update(catalogPayload(state.row, kind, state.names, page))');
    expect(hotPath).not.toContain('catalogRow(');
    expect(hotPath).not.toContain('refreshEntries(');
    expect(hotPath).not.toContain('liveEntries(');
    expect(hotPath).not.toContain('.channels.fetch(');
    expect(hotPath).not.toContain('.messages.fetch(');
    expect(hotPath).not.toContain('interaction.deferUpdate()');
  });

  it('makes search snapshot-only, ephemeral, ranked and user-bound', () => {
    expect(catalog).toContain('const SEARCH_SESSION_TTL_MS = 5 * 60_000');
    expect(catalog).toContain('const catalogSearchSessions = new Map<string, CatalogSearchSession>()');
    expect(catalog).toContain("value.normalize('NFKC')");
    expect(catalog).toContain('value === needle ? 0 : value.startsWith(needle) ? 1 : 2');
    expect(catalog).toContain("setCustomId(`listcat:searchpage:${token}:");

    const searchHandler = catalog.slice(catalog.indexOf('export async function handleServerListCatalogSearch'));
    expect(searchHandler).toContain('await interaction.deferReply({ flags: MessageFlags.Ephemeral })');
    expect(searchHandler).toContain('const state = getCatalogState(interaction.guildId, connId, kind)');
    expect(searchHandler).toContain('const filtered = filterAndRankNames(state.names, query)');
    expect(searchHandler).toContain('userId: interaction.user.id');
    expect(searchHandler).toContain('await interaction.editReply(searchPayload(session, 0))');
    expect(searchHandler).not.toContain('catalogRow(');
    expect(searchHandler).not.toContain('publish(');
    expect(searchHandler).not.toContain('refreshEntries(');
    expect(searchHandler).not.toContain('liveEntries(');
    expect(searchHandler).not.toContain('.channels.fetch(');
    expect(searchHandler).not.toContain('.messages.fetch(');

    const searchPage = catalog.slice(catalog.indexOf('async function handleSearchPageButton'), catalog.indexOf('export async function handleServerListCatalogButton'));
    expect(searchPage).toContain('session.userId !== interaction.user.id');
    expect(searchPage).toContain('session.guildId !== interaction.guildId');
    expect(searchPage).toContain('await interaction.update(searchPayload(session, page))');
    expect(searchPage).not.toContain('catalogRow(');
    expect(searchPage).not.toContain('refreshEntries(');
  });

  it('allows live I/O only in explicit refresh/scheduled synchronization', () => {
    const buttonHandler = catalog.slice(catalog.indexOf('export async function handleServerListCatalogButton'), catalog.indexOf('export async function handleServerListCatalogSearch'));
    const refreshBlock = buttonHandler.slice(buttonHandler.indexOf("if (action === 'refresh')"), buttonHandler.indexOf('const state = getCatalogState(interaction.guildId, connId, kind);', buttonHandler.indexOf("if (action === 'refresh')") + 1));
    expect(refreshBlock).toContain('await interaction.deferUpdate()');
    expect(refreshBlock).toContain('await refreshEntries(row, kind)');
    expect(refreshBlock).toContain('if (!row) row = await catalogRow(interaction.guildId, connId)');
    expect(catalog).toContain('await publish(client, row, kind, 0)');
  });

  it('rejects stale public buttons and stale search modals fail closed', () => {
    expect(catalog).toContain('function isCurrentCatalogMessage');
    expect(catalog).toContain('interaction.message.author.id === interaction.client.user.id');
    expect(catalog).toContain('interaction.channelId === row[meta.channel]');
    expect(catalog).toContain('interaction.message.id === row[meta.message]');
    expect(catalog).toContain('Dieser Katalog-Button ist nicht mehr aktuell.');
    expect(catalog).toContain('state.row[meta.message] !== anchorMessageId');
    expect(catalog).toContain('state.row[meta.channel] !== interaction.channelId');
  });

  it('invalidates warm state when a catalog is removed from configuration', () => {
    expect(catalog).toContain('invalidateCatalogState(guildId, connId, kind)');
    expect(catalog).toContain('if (!row[fields(kind).channel])');
    expect(whitelistRoute).toContain('whitelistCatalogChannelId');
    expect(whitelistRoute).toContain('banCatalogChannelId');
    expect(whitelistRoute).toContain('syncServerListCatalog(client, scope.guildId, connId, kind)');
  });
});
