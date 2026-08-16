const fs = require('node:fs');
const path = require('node:path');

const file = path.join(process.cwd(), 'dashboard-ui', 'src', 'pages', 'Server.tsx');
let source = fs.readFileSync(file, 'utf8');

function replaceOnce(needle, replacement, label) {
  const first = source.indexOf(needle);
  if (first < 0) throw new Error(`Missing transform anchor: ${label}`);
  if (source.indexOf(needle, first + needle.length) >= 0) throw new Error(`Non-unique transform anchor: ${label}`);
  source = source.slice(0, first) + replacement + source.slice(first + needle.length);
}

replaceOnce(', Users, Crosshair, RotateCcw,', ', Users, RotateCcw,', 'Crosshair import');
replaceOnce(" | 'killfeed'", '', 'killfeed Tab union');
replaceOnce("  { key: 'killfeed', label: 'Killfeed', icon: Crosshair },\n", '', 'standalone killfeed nav');
replaceOnce(
  "            {tab === 'nitrado' && guildId && <NitradoTab guildId={guildId} isOwner={isOwner} slots={dash.data.slots} />}",
  "            {tab === 'nitrado' && guildId && <NitradoTab guildId={guildId} isOwner={isOwner} canManageKillfeed={isOwner || hasFullAccess || perms.includes('killfeed.manage')} slots={dash.data.slots} />}",
  'NitradoTab render',
);
replaceOnce(
  "            {tab === 'killfeed' && guildId && <KillfeedTab guildId={guildId} isOwner={isOwner || hasFullAccess || perms.includes('killfeed.manage')} slots={dash.data.slots} />}\n",
  '',
  'standalone killfeed render',
);

const functionStart = source.indexOf('function NitradoTab(');
const functionEnd = source.indexOf('\nfunction SlotRow(', functionStart);
if (functionStart < 0 || functionEnd < 0) throw new Error('NitradoTab function anchors missing');

const replacement = `function NitradoTab({ guildId, isOwner, canManageKillfeed, slots }: { guildId: string; isOwner: boolean; canManageKillfeed: boolean; slots: Slot[] }) {
  const qc = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const [page, setPage] = useState<1 | 2>(() => isOwner ? 1 : 2);

  const remove = useMutation({
    mutationFn: (slot: number) => api.del(\`/api/v2/guilds/\${guildId}/nitrado/\${slot}\`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['dashboard', guildId] }),
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2 p-1 rounded-xl border border-border bg-bg-card/55" aria-label="Nitrado-Seiten">
        <button
          type="button"
          onClick={() => setPage(1)}
          disabled={!isOwner}
          className={\`flex-1 min-w-[180px] px-4 py-2.5 rounded-lg text-sm font-semibold transition-colors focus-ring disabled:opacity-40 disabled:cursor-not-allowed \${page === 1 ? 'bg-accent/15 text-accent border border-accent/30 shadow-glow-sm' : 'text-muted hover:text-white hover:bg-bg-elev border border-transparent'}\`}
          aria-current={page === 1 ? 'page' : undefined}
        >
          1 · Server &amp; Verbindung
        </button>
        <button
          type="button"
          onClick={() => setPage(2)}
          disabled={!canManageKillfeed}
          className={\`flex-1 min-w-[180px] px-4 py-2.5 rounded-lg text-sm font-semibold transition-colors focus-ring disabled:opacity-40 disabled:cursor-not-allowed \${page === 2 ? 'bg-accent/15 text-accent border border-accent/30 shadow-glow-sm' : 'text-muted hover:text-white hover:bg-bg-elev border border-transparent'}\`}
          aria-current={page === 2 ? 'page' : undefined}
        >
          2 · Killfeed &amp; ADM
        </button>
      </div>

      {page === 2 ? (
        canManageKillfeed ? (
          <KillfeedTab guildId={guildId} isOwner={canManageKillfeed} slots={slots} />
        ) : (
          <Card glow>
            <CardHeader><CardTitle>Nicht erlaubt</CardTitle></CardHeader>
            <p className="text-muted text-sm">Dir fehlt die Berechtigung <code>killfeed.manage</code> oder <code>dashboard.access</code>.</p>
          </Card>
        )
      ) : isOwner ? (
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <h2 className="text-lg font-semibold text-white">Nitrado-Slots ({slots.length}/5)</h2>
              <p className="text-xs text-muted mt-1">Verbindung, Service-ID, Token und Gameserver-Slots.</p>
            </div>
            {slots.length < 5 && (
              <Button onClick={() => setShowAdd(s => !s)} size="sm">
                <Plus className="h-4 w-4 mr-1" /> {showAdd ? 'Abbrechen' : 'Slot hinzufuegen'}
              </Button>
            )}
          </div>

          {showAdd && <AddSlotForm guildId={guildId} usedSlots={slots.map(s => s.slot)} onDone={() => setShowAdd(false)} />}

          {slots.length === 0 && !showAdd && (
            <Card>
              <CardHeader><CardTitle>Noch keine Slots</CardTitle><CardDesc>Lege deinen ersten Nitrado-Slot an.</CardDesc></CardHeader>
            </Card>
          )}

          <div className="grid gap-3">
            {slots.map(s => (
              <SlotRow key={s.id} guildId={guildId} slot={s} onDelete={() => {
                if (confirm(\`Slot \${s.slot} (\${s.alias}) wirklich loeschen? Alle Daten werden geloescht.\`)) {
                  remove.mutate(s.slot);
                }
              }} />
            ))}
          </div>
        </div>
      ) : (
        <Card glow>
          <CardHeader><CardTitle>Nicht erlaubt</CardTitle></CardHeader>
          <p className="text-muted text-sm">Nur der Discord-Server-Owner kann Nitrado-Verbindungen und Slots verwalten.</p>
        </Card>
      )}
    </div>
  );
}
`;

source = source.slice(0, functionStart) + replacement + source.slice(functionEnd);

if (source.includes("key: 'killfeed'")) throw new Error('Standalone killfeed navigation survived transform');
if (source.includes("tab === 'killfeed'")) throw new Error('Standalone killfeed render survived transform');
if (!source.includes('2 · Killfeed &amp; ADM')) throw new Error('Nitrado page 2 missing');

fs.writeFileSync(file, source);
