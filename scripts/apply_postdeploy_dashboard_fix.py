from pathlib import Path
import re


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    s = p.read_text(encoding='utf-8')
    if old not in s:
        raise SystemExit(f'marker missing in {path}: {old[:120]!r}')
    p.write_text(s.replace(old, new, 1), encoding='utf-8')


def require_contains(path: str, marker: str) -> None:
    if marker not in Path(path).read_text(encoding='utf-8'):
        raise SystemExit(f'required marker missing in {path}: {marker!r}')

# ---------------------------------------------------------------------------
# 1) ServerSlot: expliziter Slot-Scope fuer ALLE Economy/Casino-Reads/Writes,
#    Page 2 Killfeed & ADM direkt unter der Screenshot-Navigation.
# ---------------------------------------------------------------------------
p = Path('dashboard-ui/src/pages/ServerSlot.tsx')
s = p.read_text(encoding='utf-8')
s = s.replace("import { VirtualAccountsPanel } from '@/components/economy/VirtualAccountsPanel';\nimport { LotteryPanel } from '@/components/economy/LotteryPanel';\n", "import { VirtualAccountsPanel } from '@/components/economy/VirtualAccountsPanel';\nimport { LotteryPanel } from '@/components/economy/LotteryPanel';\nimport { BlackMarketPanel } from '@/components/economy/BlackMarketPanel';\nimport { KillfeedTab } from '@/components/KillfeedTab';\n", 1)
s = s.replace("import { Settings, Shield, Coins, Link as LinkIcon, Trash2, Plus, Check, X, Banknote, Dice5, RefreshCw } from 'lucide-react';", "import { Settings, Shield, Coins, Link as LinkIcon, Trash2, Plus, Check, X, Banknote, Dice5, RefreshCw, Crosshair } from 'lucide-react';", 1)
s = s.replace("type Tab = 'settings' | 'whitelist' | 'economy' | 'links';", "type Tab = 'settings' | 'whitelist' | 'economy' | 'links' | 'killfeed';", 1)

marker = "interface ChannelOption { id: string; name: string; type: number; parentId: string | null; }\n"
insert = """interface ChannelOption { id: string; name: string; type: number; parentId: string | null; }

interface SlotDashboardMeta {
  isOwner: boolean;
  permissions: string[];
  slots: Array<{
    id: string;
    slot: number;
    alias: string;
    alias5: string;
    status: 'ACTIVE' | 'EXPIRED' | 'REVOKED';
  }>;
}
"""
if marker not in s: raise SystemExit('ServerSlot ChannelOption marker missing')
s = s.replace(marker, insert, 1)

s = s.replace("if (t === 'settings' || t === 'whitelist' || t === 'economy' || t === 'links') return t;", "if (t === 'settings' || t === 'whitelist' || t === 'economy' || t === 'links' || t === 'killfeed') return t;", 1)

old = """  const economy = useQuery({
    queryKey: ['economy', guildId],
    queryFn: () => api.get<EconomyConfigState>(`/api/v2/guilds/${guildId}/economy/config`),
    enabled: !!guildId,
  });

  const updateEconomy = useMutation({
    mutationFn: (patch: Partial<EconomyConfigState>) =>
      api.put(`/api/v2/guilds/${guildId}/economy/config`, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['economy', guildId] }),
  });

  const tabs = [
    ['settings', 'Settings', Settings],
    ['whitelist', 'Whitelist', Shield],
    ['economy', 'Economy', Coins],
    ['links', 'Economy-Links', LinkIcon],
  ] as const;
"""
new = """  const economy = useQuery({
    queryKey: ['economy', guildId, slot],
    queryFn: () => api.get<EconomyConfigState>(`/api/v2/guilds/${guildId}/economy/config?slot=${encodeURIComponent(slot!)}`),
    enabled: !!guildId && !!slot,
    retry: false,
  });

  const updateEconomy = useMutation({
    mutationFn: (patch: Partial<EconomyConfigState>) =>
      api.put(`/api/v2/guilds/${guildId}/economy/config?slot=${encodeURIComponent(slot!)}`, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['economy', guildId, slot] }),
  });

  const dashboardMeta = useQuery({
    queryKey: ['dashboard-slot-meta', guildId, slot],
    queryFn: () => api.get<SlotDashboardMeta>(`/api/v2/guilds/${guildId}/dashboard`),
    enabled: !!guildId && !!slot,
    retry: false,
  });
  const canManageKillfeed = Boolean(
    dashboardMeta.data?.isOwner ||
    dashboardMeta.data?.permissions.includes('dashboard.access') ||
    dashboardMeta.data?.permissions.includes('killfeed.manage'),
  );
  const currentKillfeedSlots = (dashboardMeta.data?.slots ?? []).filter(row => String(row.slot) === slot);

  const pageOneTabs = [
    ['settings', 'Settings', Settings],
    ['whitelist', 'Whitelist', Shield],
    ['economy', 'Economy', Coins],
    ['links', 'Economy-Links', LinkIcon],
  ] as const;
  const pageTwoTabs = [
    ['killfeed', 'Killfeed & ADM', Crosshair],
  ] as const;
  const tabs = [...pageOneTabs, ...pageTwoTabs] as const;
"""
if old not in s: raise SystemExit('ServerSlot economy/tabs block marker missing')
s = s.replace(old, new, 1)

old_sidebar = """  const sidebar = (
    <nav className=\"space-y-1 text-sm\">
      {tabs.map(([key, label, Icon]) => (
        <button
          key={key}
          onClick={() => setTab(key)}
          className={`w-full text-left px-3 py-2 rounded-md inline-flex items-center gap-2 transition-colors ${
            tab === key ? 'bg-accent/20 text-accent' : 'text-muted hover:bg-bg-elev hover:text-white'
          }`}
          type=\"button\"
        >
          <Icon className=\"h-4 w-4\" />
          {label}
        </button>
      ))}
    </nav>
  );
"""
new_sidebar = """  const sidebarButton = ([key, label, Icon]: (typeof tabs)[number]) => (
    <button
      key={key}
      onClick={() => setTab(key)}
      className={`w-full text-left px-3 py-2 rounded-md inline-flex items-center gap-2 transition-colors ${
        tab === key ? 'bg-accent/20 text-accent border border-accent/25' : 'text-muted hover:bg-bg-elev hover:text-white border border-transparent'
      }`}
      type=\"button\"
    >
      <Icon className=\"h-4 w-4\" />
      {label}
    </button>
  );

  const sidebar = (
    <nav className=\"space-y-1 text-sm\" aria-label=\"Slot-Funktionen\">
      <p className=\"px-3 pb-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted/60\">Page 1</p>
      {pageOneTabs.map(sidebarButton)}
      <div className=\"pt-4 mt-3 border-t border-border/60\">
        <p className=\"px-3 pb-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted/60\">Page 2</p>
        {pageTwoTabs.map(sidebarButton)}
      </div>
    </nav>
  );
"""
if old_sidebar not in s: raise SystemExit('ServerSlot sidebar marker missing')
s = s.replace(old_sidebar, new_sidebar, 1)

# Economy tab invocation and Killfeed page.
s = s.replace("""          <EconomyTab
            guildId={guildId}
            data={economy.data}
""", """          <EconomyTab
            guildId={guildId}
            slot={slot!}
            data={economy.data}
""", 1)
s = s.replace("""        {tab === 'links' && guildId && slot && (
          <EconomyLinksPanel guildId={guildId} slot={slot} />
        )}
""", """        {tab === 'links' && guildId && slot && (
          <EconomyLinksPanel guildId={guildId} slot={slot} />
        )}

        {tab === 'killfeed' && guildId && slot && (
          canManageKillfeed ? (
            currentKillfeedSlots.length > 0 ? (
              <KillfeedTab guildId={guildId} isOwner={true} slots={currentKillfeedSlots} />
            ) : (
              <Card><p className=\"text-muted text-sm\">Dieser Slot ist nicht als Nitrado-Gameserver verfuegbar.</p></Card>
            )
          ) : (
            <Card>
              <CardHeader><CardTitle>Nicht erlaubt</CardTitle></CardHeader>
              <p className=\"text-muted text-sm\">Dir fehlt <code>killfeed.manage</code> oder <code>dashboard.access</code>.</p>
            </Card>
          )
        )}
""", 1)

# EconomyOverview
s = s.replace("function EconomyOverview({ guildId }: { guildId: string }) {", "function EconomyOverview({ guildId, slot }: { guildId: string; slot: string }) {", 1)
s = s.replace("queryKey: ['economy-overview', guildId],", "queryKey: ['economy-overview', guildId, slot],", 1)
s = s.replace("api.get<EconomyOverviewData>(`/api/v2/guilds/${guildId}/economy/overview`)", "api.get<EconomyOverviewData>(`/api/v2/guilds/${guildId}/economy/overview?slot=${encodeURIComponent(slot)}`)", 1)

# EconomyTab props + children
s = s.replace("""function EconomyTab({
  guildId, data, loading, onSave, pending,
}: {
  guildId: string;
""", """function EconomyTab({
  guildId, slot, data, loading, onSave, pending,
}: {
  guildId: string;
  slot: string;
""", 1)
s = s.replace("<EconomyOverview guildId={guildId} />", "<EconomyOverview guildId={guildId} slot={slot} />", 1)
s = s.replace("<VirtualAccountsPanel guildId={guildId} />", "<VirtualAccountsPanel guildId={guildId} slot={slot} />", 1)
s = s.replace("<LotteryPanel guildId={guildId} />", "<LotteryPanel guildId={guildId} slot={slot} />", 1)
s = s.replace("""      <Card>
        <CardHeader><CardTitle><span className=\"inline-flex items-center gap-2\"><Dice5 className=\"h-4 w-4\" />Casino-Games</span></CardTitle></CardHeader>
        <CasinoTable guildId={guildId} />
      </Card>

      <Card>
        <CardHeader><CardTitle>Admin-Auszahlung</CardTitle></CardHeader>
        <AdminPayForm guildId={guildId} />
      </Card>
""", """      <BlackMarketPanel guildId={guildId} slot={slot} />

      <Card>
        <CardHeader><CardTitle><span className=\"inline-flex items-center gap-2\"><Dice5 className=\"h-4 w-4\" />Casino-Games</span></CardTitle></CardHeader>
        <CasinoTable guildId={guildId} slot={slot} />
      </Card>

      <Card>
        <CardHeader><CardTitle>Admin-Auszahlung</CardTitle></CardHeader>
        <AdminPayForm guildId={guildId} slot={slot} />
      </Card>
""", 1)

# Casino table explicit scope + cache isolation.
s = s.replace("function CasinoTable({ guildId }: { guildId: string }) {", "function CasinoTable({ guildId, slot }: { guildId: string; slot: string }) {", 1)
s = s.replace("queryKey: ['casino-games', guildId],", "queryKey: ['casino-games', guildId, slot],", 1)
s = s.replace("`/api/v2/guilds/${guildId}/casino/games`", "`/api/v2/guilds/${guildId}/casino/games?slot=${encodeURIComponent(slot)}`", 1)
s = s.replace("queryKey: ['casino-stats', guildId],", "queryKey: ['casino-stats', guildId, slot],", 1)
s = s.replace("`/api/v2/guilds/${guildId}/casino/stats`", "`/api/v2/guilds/${guildId}/casino/stats?slot=${encodeURIComponent(slot)}`", 1)
s = s.replace("api.put(`/api/v2/guilds/${guildId}/casino/games/${vars.type}`, vars.patch)", "api.put(`/api/v2/guilds/${guildId}/casino/games/${vars.type}?slot=${encodeURIComponent(slot)}`, vars.patch)", 1)
s = s.replace("qc.invalidateQueries({ queryKey: ['casino-games', guildId] })", "qc.invalidateQueries({ queryKey: ['casino-games', guildId, slot] })", 1)
s = s.replace("qc.invalidateQueries({ queryKey: ['casino-stats', guildId] })", "qc.invalidateQueries({ queryKey: ['casino-stats', guildId, slot] })", 1)

# Admin pay explicit scope.
s = s.replace("function AdminPayForm({ guildId }: { guildId: string }) {", "function AdminPayForm({ guildId, slot }: { guildId: string; slot: string }) {", 1)
s = s.replace("api.post(`/api/v2/guilds/${guildId}/economy/accounts/${userId}/admin-pay`, {", "api.post(`/api/v2/guilds/${guildId}/economy/accounts/${userId}/admin-pay?slot=${encodeURIComponent(slot)}`, {", 1)

p.write_text(s, encoding='utf-8')

# ---------------------------------------------------------------------------
# 2) VirtualAccountsPanel + LotteryPanel: explicit slot scope + query cache key.
# ---------------------------------------------------------------------------
p = Path('dashboard-ui/src/components/economy/VirtualAccountsPanel.tsx')
s = p.read_text(encoding='utf-8')
s = s.replace("export function VirtualAccountsPanel({ guildId }: { guildId: string }) {", "export function VirtualAccountsPanel({ guildId, slot }: { guildId: string; slot: string }) {\n  const scope = `slot=${encodeURIComponent(slot)}`;", 1)
s = s.replace("['economy-virtual-accounts', guildId]", "['economy-virtual-accounts', guildId, slot]")
s = s.replace("`/api/v2/guilds/${guildId}/economy/virtual-accounts?includeArchived=true`", "`/api/v2/guilds/${guildId}/economy/virtual-accounts?${scope}&includeArchived=true`")
s = s.replace("`/api/v2/guilds/${guildId}/economy/virtual-accounts`,", "`/api/v2/guilds/${guildId}/economy/virtual-accounts?${scope}`,", 1)
s = s.replace("`/api/v2/guilds/${guildId}/economy/virtual-accounts/${accountId}/archive`", "`/api/v2/guilds/${guildId}/economy/virtual-accounts/${accountId}/archive?${scope}`")
s = s.replace("`/api/v2/guilds/${guildId}/economy/virtual-accounts/${payout.accountId}/payout`", "`/api/v2/guilds/${guildId}/economy/virtual-accounts/${payout.accountId}/payout?${scope}`")
s = s.replace("['economy-virtual-account-audit', guildId, auditAccountId]", "['economy-virtual-account-audit', guildId, slot, auditAccountId]")
s = s.replace("`/api/v2/guilds/${guildId}/economy/virtual-accounts/${auditAccountId}/entries?limit=50`", "`/api/v2/guilds/${guildId}/economy/virtual-accounts/${auditAccountId}/entries?${scope}&limit=50`")
p.write_text(s, encoding='utf-8')

p = Path('dashboard-ui/src/components/economy/LotteryPanel.tsx')
s = p.read_text(encoding='utf-8')
s = s.replace("export function LotteryPanel({ guildId }: { guildId: string }) {", "export function LotteryPanel({ guildId, slot }: { guildId: string; slot: string }) {\n  const scope = `slot=${encodeURIComponent(slot)}`;", 1)
s = s.replace("['economy-lottery-current', guildId]", "['economy-lottery-current', guildId, slot]")
s = s.replace("['economy-lottery-history', guildId]", "['economy-lottery-history', guildId, slot]")
s = s.replace("['economy-virtual-accounts', guildId]", "['economy-virtual-accounts', guildId, slot]")
s = s.replace("`/api/v2/guilds/${guildId}/economy/lottery/current`", "`/api/v2/guilds/${guildId}/economy/lottery/current?${scope}`")
s = s.replace("`/api/v2/guilds/${guildId}/economy/lottery/history?limit=10`", "`/api/v2/guilds/${guildId}/economy/lottery/history?${scope}&limit=10`")
s = s.replace("`/api/v2/guilds/${guildId}/economy/lottery/rounds`", "`/api/v2/guilds/${guildId}/economy/lottery/rounds?${scope}`")
s = s.replace("`/api/v2/guilds/${guildId}/economy/lottery/${roundId}/end-now`", "`/api/v2/guilds/${guildId}/economy/lottery/${roundId}/end-now?${scope}`")
p.write_text(s, encoding='utf-8')

# ---------------------------------------------------------------------------
# 3) Killfeed aus uebergeordneter Server-Seite entfernen: eine einzige
#    kanonische Dashboard-Stelle = Slot Page 2.
# ---------------------------------------------------------------------------
p = Path('dashboard-ui/src/pages/Server.tsx')
s = p.read_text(encoding='utf-8')
s = s.replace("import { KillfeedTab } from '@/components/KillfeedTab';\n", '', 1)
s = s.replace("<NitradoTab guildId={guildId} isOwner={isOwner} canManageKillfeed={isOwner || hasFullAccess || perms.includes('killfeed.manage')} slots={dash.data.slots} />", "<NitradoTab guildId={guildId} isOwner={isOwner} slots={dash.data.slots} />", 1)
start = s.find("function NitradoTab({ guildId, isOwner, canManageKillfeed, slots }:")
end = s.find("\nfunction SlotRow(", start)
if start == -1 or end == -1:
    raise SystemExit('Server.tsx NitradoTab boundaries missing')
replacement = '''function NitradoTab({ guildId, isOwner, slots }: { guildId: string; isOwner: boolean; slots: Slot[] }) {
  const qc = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);

  const remove = useMutation({
    mutationFn: (slot: number) => api.del(`/api/v2/guilds/${guildId}/nitrado/${slot}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['dashboard', guildId] }),
  });

  if (!isOwner) {
    return (
      <Card glow>
        <CardHeader><CardTitle>Nicht erlaubt</CardTitle></CardHeader>
        <p className="text-muted text-sm">Nur der Discord-Server-Owner kann Nitrado-Verbindungen und Slots verwalten.</p>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold text-white">Nitrado-Slots ({slots.length}/5)</h2>
          <p className="text-xs text-muted mt-1">Page 1: Verbindung, Service-ID, Token und Gameserver-Slots. Killfeed & ADM liegen direkt im jeweiligen Slot unter Page 2.</p>
        </div>
        {slots.length < 5 && (
          <Button onClick={() => setShowAdd(value => !value)} size="sm">
            <Plus className="h-4 w-4 mr-1" /> {showAdd ? 'Abbrechen' : 'Slot hinzufuegen'}
          </Button>
        )}
      </div>

      {showAdd && <AddSlotForm guildId={guildId} usedSlots={slots.map(row => row.slot)} onDone={() => setShowAdd(false)} />}
      {slots.length === 0 && !showAdd && (
        <Card><CardHeader><CardTitle>Noch keine Slots</CardTitle><CardDesc>Lege deinen ersten Nitrado-Slot an.</CardDesc></CardHeader></Card>
      )}
      <div className="grid gap-3">
        {slots.map(row => (
          <SlotRow key={row.id} guildId={guildId} slot={row} onDelete={() => {
            if (confirm(`Slot ${row.slot} (${row.alias}) wirklich loeschen? Alle Daten werden geloescht.`)) remove.mutate(row.slot);
          }} />
        ))}
      </div>
    </div>
  );
}
'''
s = s[:start] + replacement + s[end:]
p.write_text(s, encoding='utf-8')

# ---------------------------------------------------------------------------
# 4) /help: kleine Begruessung statt kompletter Command-Liste.
# ---------------------------------------------------------------------------
p = Path('src/commands/user/help.ts')
s = p.read_text(encoding='utf-8')
start = s.find('function overviewEmbed(entries: CommandCatalogEntry[]): EmbedBuilder {')
end = s.find('\nfunction optionToken(', start)
if start == -1 or end == -1:
    raise SystemExit('help overview boundaries missing')
new_overview = '''function overviewEmbed(_entries: CommandCatalogEntry[]): EmbedBuilder {
  return vEmbed(Colors.Primary)
    .setTitle('👋 Willkommen bei V-Bot Prime')
    .setDescription(
      'Hier findest du die freigegebenen Funktionen von V-Bot – ohne eine lange Command-Wand.\\n\\n' +
      '**So funktioniert die Hilfe:**\\n' +
      '1. Waehle unten zuerst einen Bereich aus.\\n' +
      '2. Auf der Funktionsseite bringt dich **▶️ Weiter** zur naechsten Funktion.\\n' +
      '3. Mit **◀️ Zurueck** gehst du wieder eine Funktion zurueck.\\n' +
      '4. Mit **📚 Katalog** kommst du jederzeit hierher zurueck.\\n\\n' +
      `${Brand.divider}\\n` +
      '_DEV-Funktionen und `/ai` bleiben bewusst ausserhalb dieser Nutzer-Hilfe._',
    )
    .setFooter({ text: 'Bereich auswaehlen · dann mit ◀️ / ▶️ durch die Funktionen navigieren' });
}
'''
s = s[:start] + new_overview + s[end:]
p.write_text(s, encoding='utf-8')

# ---------------------------------------------------------------------------
# 5) Theme: Schalter sichtbarer + Shell-Surfaces wirklich theme-abhaengig.
# ---------------------------------------------------------------------------
p = Path('dashboard-ui/src/components/Shell.tsx')
s = p.read_text(encoding='utf-8')
s = s.replace('<div className="min-h-full flex flex-col">', '<div className="dashboard-shell min-h-full flex flex-col" data-dashboard-theme={theme}>', 1)
s = s.replace("""              className="inline-flex items-center justify-center h-9 w-9 rounded-md text-muted hover:text-white hover:bg-bg-elev focus-ring"
              aria-label={`Farbschema auf ${nextThemeLabel} umschalten`}
              data-testid="theme-toggle"
            >
              <Palette className="h-4 w-4" />
""", """              className="theme-toggle-control inline-flex items-center justify-center sm:justify-start gap-1.5 h-9 min-w-9 sm:min-w-[92px] px-2 rounded-md text-muted hover:text-white focus-ring border border-border/60 bg-bg-elev/55"
              aria-label={`Farbschema auf ${nextThemeLabel} umschalten`}
              data-testid="theme-toggle"
            >
              <Palette className="h-4 w-4 shrink-0" />
              <span className="hidden sm:inline text-xs font-semibold">{themeLabel}</span>
""", 1)
s = s.replace("className=\"hidden md:block w-64 lg:w-72 border-r border-white/[0.06] bg-gradient-to-b from-bg-card/70 to-bg-card/35 backdrop-blur-md p-5 overflow-y-auto text-[15px]\"", "className=\"dashboard-sidebar hidden md:block w-64 lg:w-72 border-r border-border/60 backdrop-blur-md p-5 overflow-y-auto text-[15px]\"", 1)
s = s.replace('<main className="flex-1 overflow-y-auto p-4 sm:p-6" role="main">', '<main className="dashboard-main flex-1 overflow-y-auto p-4 sm:p-6" role="main">', 1)
p.write_text(s, encoding='utf-8')

p = Path('dashboard-ui/src/theme.css')
s = p.read_text(encoding='utf-8')
s = s.replace("""html[data-theme='ice'] {
  color-scheme: dark;
  --color-bg: 6 13 24;
  --color-bg-card: 10 22 38;
  --color-bg-elev: 16 34 54;
  --color-bg-hover: 23 46 70;
  --color-bg-subtle: 7 17 30;
  --color-fg: 244 250 255;
  --color-muted: 151 174 198;
  --color-border: 42 67 91;
  --color-accent: 56 189 248;
  --color-accent-hover: 96 205 250;
  --color-accent-glow: 125 211 252;
  --color-accent-dim: 7 89 133;
}
""", """html[data-theme='ice'] {
  color-scheme: dark;
  --color-bg: 8 24 42;
  --color-bg-card: 18 43 68;
  --color-bg-elev: 29 61 92;
  --color-bg-hover: 40 78 113;
  --color-bg-subtle: 10 31 53;
  --color-fg: 248 252 255;
  --color-muted: 177 205 229;
  --color-border: 73 112 146;
  --color-accent: 125 211 252;
  --color-accent-hover: 186 230 253;
  --color-accent-glow: 224 242 254;
  --color-accent-dim: 14 116 144;
}
""", 1)
append = r'''

/* Sichtbarer Shell-Wechsel: nicht nur einzelne Accent-Tokens, sondern das
   komplette Dashboard-Overlay reagiert auf Obsidian/Ice. */
html[data-theme='obsidian'] .dashboard-sidebar {
  background: linear-gradient(180deg, rgba(15,19,25,.96), rgba(8,10,14,.88));
  box-shadow: inset -1px 0 rgba(210,43,58,.08), 18px 0 48px -36px rgba(210,43,58,.42);
}
html[data-theme='obsidian'] .dashboard-main {
  background: radial-gradient(ellipse at 88% 0%, rgba(210,43,58,.055), transparent 38%);
}
html[data-theme='ice'] .dashboard-sidebar {
  background:
    linear-gradient(180deg, rgba(23,54,83,.97), rgba(8,24,42,.93)),
    radial-gradient(circle at 15% 8%, rgba(224,242,254,.12), transparent 28%);
  border-right-color: rgba(125,211,252,.28);
  box-shadow: inset -1px 0 rgba(224,242,254,.10), 20px 0 52px -36px rgba(56,189,248,.58);
}
html[data-theme='ice'] .dashboard-main {
  background:
    radial-gradient(ellipse at 86% 2%, rgba(186,230,253,.12), transparent 34%),
    linear-gradient(145deg, rgba(29,61,92,.18), transparent 42%);
}
html[data-theme='obsidian'] .theme-toggle-control {
  box-shadow: inset 0 0 0 1px rgba(210,43,58,.10), 0 0 20px -14px rgba(210,43,58,.75);
}
html[data-theme='ice'] .theme-toggle-control {
  color: rgb(224 242 254);
  border-color: rgba(125,211,252,.42);
  background: linear-gradient(180deg, rgba(40,78,113,.86), rgba(18,43,68,.92));
  box-shadow: inset 0 1px rgba(255,255,255,.10), 0 0 24px -12px rgba(125,211,252,.72);
}
'''
if '.dashboard-sidebar' not in s:
    s += append
p.write_text(s, encoding='utf-8')

# ---------------------------------------------------------------------------
# 6) Discord.js Deprecations aus Runtime-Logs.
# ---------------------------------------------------------------------------
p = Path('src/modules/ai/guildAwareness.ts')
s = p.read_text(encoding='utf-8')
s = s.replace("typeof (ch as any).messages?.fetchPinned === 'function'", "typeof (ch as any).messages?.fetchPins === 'function'")
s = s.replace('(ch as any).messages.fetchPinned()', '(ch as any).messages.fetchPins()')
p.write_text(s, encoding='utf-8')

# ephemeral: true -> flags: MessageFlags.Ephemeral, mit Import-Haertung.
for p in Path('src').rglob('*.ts'):
    s = p.read_text(encoding='utf-8')
    if 'ephemeral: true' not in s:
        continue
    s = s.replace('ephemeral: true', 'flags: MessageFlags.Ephemeral')
    if 'MessageFlags' not in s.split("from 'discord.js'", 1)[0]:
        # Multi-line und Single-line Named-Imports werden beide abgedeckt.
        m = re.search(r"import\s*\{([\s\S]*?)\}\s*from\s*'discord\.js';", s)
        if not m:
            raise SystemExit(f'discord.js named import missing for {p}')
        names = m.group(1)
        if 'MessageFlags' not in names:
            new_names = '\n  MessageFlags,' + names if '\n' in names else ' MessageFlags,' + names
            s = s[:m.start(1)] + new_names + s[m.end(1):]
    p.write_text(s, encoding='utf-8')

# ---------------------------------------------------------------------------
# 7) Gemini 2.0 ist seit 2026-06-01 abgeschaltet. Exakte bekannte Legacy-Werte
#    migrieren fail-safe auf den offiziellen Ersatz, Custom-Modelle respektieren.
# ---------------------------------------------------------------------------
p = Path('src/config.ts')
s = p.read_text(encoding='utf-8')
helper_marker = "const metricsToken = optionalEnv('METRICS_TOKEN', '').trim();\n"
helper = """function resolveGeminiModel(): string {
  const configured = optionalEnv('GEMINI_MODEL', 'gemini-3.6-flash').trim();
  if (configured === 'gemini-2.0-flash' || configured === 'gemini-2.0-flash-001') return 'gemini-3.6-flash';
  if (configured === 'gemini-2.0-flash-lite' || configured === 'gemini-2.0-flash-lite-001') return 'gemini-3.1-flash-lite';
  return configured || 'gemini-3.6-flash';
}

const metricsToken = optionalEnv('METRICS_TOKEN', '').trim();
"""
if helper_marker not in s: raise SystemExit('config helper marker missing')
s = s.replace(helper_marker, helper, 1)
s = s.replace("geminiModel: optionalEnv('GEMINI_MODEL', 'gemini-2.0-flash'),", "geminiModel: resolveGeminiModel(),", 1)
p.write_text(s, encoding='utf-8')

p = Path('.env.example')
s = p.read_text(encoding='utf-8')
s = s.replace('GEMINI_MODEL=gemini-2.0-flash', 'GEMINI_MODEL=gemini-3.6-flash', 1)
p.write_text(s, encoding='utf-8')

# ---------------------------------------------------------------------------
# 8) Feed-Konfigurationsfehler bleiben Backoff-faehig, werden aber nicht als
#    Prozess-/Runtime-Crash geloggt. Keine automatische Deaktivierung.
# ---------------------------------------------------------------------------
p = Path('src/modules/feeds/feedManagerV2.ts')
s = p.read_text(encoding='utf-8')
marker = "const feedIntervals = new Map<string, number>();\nlet feedRefreshTimer: NodeJS.Timeout | null = null;\n"
insert = """const feedIntervals = new Map<string, number>();
let feedRefreshTimer: NodeJS.Timeout | null = null;

function isFeedConfigurationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Twitch-Credentials fehlen|Ziel-Channel ist nicht erreichbar|Gespeicherte .*Quelle ist ungültig/i.test(message);
}
"""
if marker not in s: raise SystemExit('feed timer marker missing')
s = s.replace(marker, insert, 1)
s = s.replace("logger.error(`Feed-Verarbeitung fehlgeschlagen (${feedId}):`, error);", """if (isFeedConfigurationError(error)) {
      logger.warn(`Feed ${feedId}: Konfiguration unvollstaendig/ungueltig; Retry nach Backoff. ${error instanceof Error ? error.message : String(error)}`);
    } else {
      logger.error(`Feed-Verarbeitung fehlgeschlagen (${feedId}):`, error);
    }""", 1)
p.write_text(s, encoding='utf-8')

# ---------------------------------------------------------------------------
# Sanity markers.
# ---------------------------------------------------------------------------
for path, markers in {
    'dashboard-ui/src/pages/ServerSlot.tsx': ['Page 1', 'Page 2', 'Killfeed & ADM', 'BlackMarketPanel', 'slot=${encodeURIComponent(slot'],
    'src/commands/user/help.ts': ['Willkommen bei V-Bot Prime', '▶️ Weiter', '◀️ Zurueck'],
    'dashboard-ui/src/theme.css': ['.dashboard-sidebar', "html[data-theme='ice'] .dashboard-main"],
    'src/modules/ai/guildAwareness.ts': ['fetchPins()'],
    'src/config.ts': ['resolveGeminiModel', "'gemini-3.6-flash'"],
}.items():
    for marker in markers:
        require_contains(path, marker)

print('post-deploy dashboard/runtime fix applied')
