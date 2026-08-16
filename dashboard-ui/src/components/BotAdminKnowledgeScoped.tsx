import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BookOpen, Download, Inbox, Loader2, RefreshCw, Trash2 } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardDesc, CardHeader, CardTitle } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { useToast } from '@/components/ui/Toast';

interface GuildOption {
  id: string;
  name: string;
  memberCount: number;
}

interface GameserverOption {
  id: string;
  slot: number;
  alias: string;
  alias5: string;
}

interface KnowledgeScope {
  type: 'GLOBAL' | 'GAMESERVER';
  nitradoConnId: string | null;
  slot: number | null;
  alias: string | null;
  alias5: string | null;
}

interface KnowledgeRow {
  id: string;
  label: string;
  content: string;
  createdBy: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  hasEmbedding: boolean;
  embeddingModel: string | null;
  embeddedAt: string | null;
  scope: KnowledgeScope;
}

interface KnowledgeData {
  items: KnowledgeRow[];
  gameservers: GameserverOption[];
  persona: string | null;
  brief: string | null;
  briefAt: string | null;
  activeCount: number;
  maxSnippets: number;
}

interface ExportItem {
  label: string;
  content: string;
  scopeType: 'GLOBAL' | 'GAMESERVER';
  scopeSlot: number | null;
}

interface ExportPayload {
  guildId: string;
  exportedAt: string;
  items: ExportItem[];
}

function errorMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : (error as Error)?.message ?? 'Unbekannter Fehler';
}

function scopeLabel(scope: KnowledgeScope): string {
  if (scope.type === 'GLOBAL') return 'Guild-global';
  const alias = scope.alias || scope.alias5;
  return `Slot ${scope.slot ?? '?'}${alias ? ` · ${alias}` : ''}`;
}

function queryUrl(path: string, guildId: string): string {
  return `${path}${path.includes('?') ? '&' : '?'}guildId=${encodeURIComponent(guildId)}`;
}

export function BotAdminKnowledgeScoped() {
  const base = '/api/v2/bot-admin';
  const qc = useQueryClient();
  const toast = useToast();
  const [guildId, setGuildId] = useState('');
  const [scopeFilter, setScopeFilter] = useState<'ALL' | 'GLOBAL' | string>('ALL');
  const [showCreate, setShowCreate] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);

  const guildsQ = useQuery({
    queryKey: [base, 'guilds', 'knowledge-v2'],
    queryFn: () => api.get<{ items: GuildOption[] }>(`${base}/guilds`),
  });

  const knowledgeQ = useQuery({
    queryKey: [base, 'knowledge-v2', guildId],
    queryFn: () => api.get<KnowledgeData>(queryUrl(`${base}/knowledge`, guildId)),
    enabled: Boolean(guildId),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: [base, 'knowledge-v2', guildId] });

  const create = useMutation({
    mutationFn: (body: { label: string; content: string; nitradoConnId: string | null }) =>
      api.post(queryUrl(`${base}/knowledge`, guildId), body),
    onSuccess: () => {
      toast.success('Knowledge-Snippet erstellt.');
      setShowCreate(false);
      void invalidate();
    },
    onError: error => toast.error(errorMessage(error)),
  });

  const update = useMutation({
    mutationFn: (vars: { id: string; body: { label: string; content: string; nitradoConnId: string | null } }) =>
      api.patch(queryUrl(`${base}/knowledge/${vars.id}`, guildId), vars.body),
    onSuccess: () => {
      toast.success('Knowledge-Snippet aktualisiert.');
      setEditId(null);
      void invalidate();
    },
    onError: error => toast.error(errorMessage(error)),
  });

  const toggle = useMutation({
    mutationFn: (vars: { id: string; active: boolean }) =>
      api.post(queryUrl(`${base}/knowledge/${vars.id}/toggle`, guildId), { active: vars.active }),
    onSuccess: () => void invalidate(),
    onError: error => toast.error(errorMessage(error)),
  });

  const reembed = useMutation({
    mutationFn: (id: string) => api.post<{ message?: string }>(queryUrl(`${base}/knowledge/${id}/reembed`, guildId)),
    onSuccess: result => {
      toast.success(result.message ?? 'Embedding neu berechnet.');
      void invalidate();
    },
    onError: error => toast.error(errorMessage(error)),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.del(queryUrl(`${base}/knowledge/${id}`, guildId)),
    onSuccess: () => {
      toast.success('Knowledge-Snippet deaktiviert.');
      void invalidate();
    },
    onError: error => toast.error(errorMessage(error)),
  });

  const importMutation = useMutation({
    mutationFn: (items: ExportItem[]) =>
      api.post<{ added: number; skipped: number }>(queryUrl(`${base}/knowledge/import`, guildId), { items }),
    onSuccess: result => {
      toast.success(`${result.added} importiert, ${result.skipped} übersprungen.`);
      setShowImport(false);
      void invalidate();
    },
    onError: error => toast.error(errorMessage(error)),
  });

  const persona = useMutation({
    mutationFn: (value: string | null) => api.put(queryUrl(`${base}/knowledge/persona`, guildId), { persona: value }),
    onSuccess: () => {
      toast.success('Persona gespeichert.');
      void invalidate();
    },
    onError: error => toast.error(errorMessage(error)),
  });

  const brief = useMutation({
    mutationFn: () => api.post<{ brief: string }>(queryUrl(`${base}/knowledge/brief/regenerate`, guildId)),
    onSuccess: () => {
      toast.success('AI-Brief neu generiert.');
      void invalidate();
    },
    onError: error => toast.error(errorMessage(error)),
  });

  const filteredItems = useMemo(() => {
    const items = knowledgeQ.data?.items ?? [];
    if (scopeFilter === 'ALL') return items;
    if (scopeFilter === 'GLOBAL') return items.filter(item => item.scope.type === 'GLOBAL');
    return items.filter(item => item.scope.nitradoConnId === scopeFilter);
  }, [knowledgeQ.data?.items, scopeFilter]);

  async function exportJson(): Promise<void> {
    if (!guildId) return;
    try {
      const payload = await api.get<ExportPayload>(queryUrl(`${base}/knowledge/export`, guildId));
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `wissensbank-${guildId}-${Date.now()}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      toast.success(`${payload.items.length} Snippets exportiert.`);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  const data = knowledgeQ.data;
  return (
    <div className="space-y-4" data-testid="botadmin-knowledge-scoped">
      <Card glow>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><BookOpen className="h-5 w-5" /> AI-Wissensbank 2.0</CardTitle>
          <CardDesc>Guild-globales und gameserver-spezifisches RAG-Wissen. Serverfremde Snippets werden vor dem Hybrid-Ranking ausgeschlossen.</CardDesc>
        </CardHeader>

        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-end">
          <label className="space-y-1">
            <span className="text-xs text-muted">Discord-Server</span>
            <Select
              value={guildId}
              onChange={event => {
                setGuildId(event.target.value);
                setScopeFilter('ALL');
                setEditId(null);
                setShowCreate(false);
                setShowImport(false);
              }}
              aria-label="Discord-Server für Wissensbank"
            >
              <option value="">— Server wählen —</option>
              {(guildsQ.data?.items ?? []).map(guild => (
                <option key={guild.id} value={guild.id}>{guild.name} ({guild.memberCount})</option>
              ))}
            </Select>
          </label>

          <label className="space-y-1">
            <span className="text-xs text-muted">Anzeige-Scope</span>
            <Select
              value={scopeFilter}
              onChange={event => setScopeFilter(event.target.value)}
              disabled={!guildId || !data}
              aria-label="Knowledge-Scope filtern"
            >
              <option value="ALL">Alle erlaubten Scopes</option>
              <option value="GLOBAL">Nur Guild-global</option>
              {(data?.gameservers ?? []).map(server => (
                <option key={server.id} value={server.id}>Slot {server.slot} · {server.alias || server.alias5}</option>
              ))}
            </Select>
          </label>

          <Button variant="ghost" onClick={() => knowledgeQ.refetch()} disabled={!guildId || knowledgeQ.isFetching} aria-label="Wissensbank aktualisieren">
            {knowledgeQ.isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Aktualisieren
          </Button>
        </div>
      </Card>

      {!guildId && (
        <Card glow><EmptyState icon={Inbox} title="Server wählen" desc="Wähle zuerst die Discord-Guild. Danach stehen globale und gebundene Gameserver-Scopes zur Verfügung." /></Card>
      )}

      {guildId && knowledgeQ.isError && (
        <Card glow><p className="text-sm text-danger">{errorMessage(knowledgeQ.error)}</p></Card>
      )}

      {guildId && data && (
        <>
          <Card glow>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between mb-4">
              <div>
                <h2 className="text-lg font-semibold text-white">Knowledge-Snippets</h2>
                <p className="text-sm text-muted mt-0.5">{data.activeCount}/{data.maxSnippets} aktiv · {data.gameservers.length} produktive Gameserver auswählbar</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="ghost" onClick={() => void exportJson()} disabled={data.items.length === 0}><Download className="h-4 w-4" />Export</Button>
                <Button variant="secondary" onClick={() => { setShowImport(value => !value); setShowCreate(false); }}>{showImport ? 'Import schließen' : 'Import'}</Button>
                <Button onClick={() => { setShowCreate(value => !value); setShowImport(false); }}>{showCreate ? 'Neu schließen' : 'Neu'}</Button>
              </div>
            </div>

            {showCreate && (
              <KnowledgeEditor
                gameservers={data.gameservers}
                loading={create.isPending}
                submitLabel="Hinzufügen"
                onSubmit={value => create.mutate(value)}
                onCancel={() => setShowCreate(false)}
              />
            )}

            {showImport && (
              <KnowledgeImport
                loading={importMutation.isPending}
                onSubmit={items => importMutation.mutate(items)}
                onCancel={() => setShowImport(false)}
              />
            )}

            {filteredItems.length === 0 && !showCreate && !showImport && (
              <EmptyState icon={Inbox} title="Keine Snippets in diesem Scope" desc="Der Filter enthält aktuell keine Knowledge-Einträge." />
            )}

            <div className="space-y-3">
              {filteredItems.map(item => editId === item.id ? (
                <KnowledgeEditor
                  key={item.id}
                  gameservers={data.gameservers}
                  initial={item}
                  loading={update.isPending}
                  submitLabel="Speichern"
                  onSubmit={value => update.mutate({ id: item.id, body: value })}
                  onCancel={() => setEditId(null)}
                />
              ) : (
                <Card key={item.id} className="!p-4">
                  <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold text-white break-words">{item.label}</span>
                        <Badge variant={item.scope.type === 'GLOBAL' ? 'neutral' : 'info'}>{scopeLabel(item.scope)}</Badge>
                        <Badge variant={item.isActive ? 'ok' : 'neutral'}>{item.isActive ? 'aktiv' : 'inaktiv'}</Badge>
                        <Badge variant={item.hasEmbedding ? 'info' : 'warn'}>{item.hasEmbedding ? 'Embedding' : 'Keyword'}</Badge>
                      </div>
                      <p className="mt-2 text-sm text-muted whitespace-pre-wrap break-words">{item.content}</p>
                      <p className="mt-2 text-[11px] text-muted">Aktualisiert: {new Date(item.updatedAt).toLocaleString('de-DE')}{item.embeddingModel ? ` · ${item.embeddingModel}` : ''}</p>
                    </div>
                    <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap md:max-w-[310px] md:justify-end shrink-0">
                      <Button variant="secondary" onClick={() => { setEditId(item.id); setShowCreate(false); setShowImport(false); }}>Bearbeiten</Button>
                      <Button variant="ghost" onClick={() => toggle.mutate({ id: item.id, active: !item.isActive })}>{item.isActive ? 'Deaktivieren' : 'Aktivieren'}</Button>
                      <Button variant="ghost" onClick={() => reembed.mutate(item.id)} loading={reembed.isPending}>Re-Embed</Button>
                      <Button variant="danger" onClick={() => remove.mutate(item.id)} aria-label={`${item.label} deaktivieren`}><Trash2 className="h-4 w-4" />Deaktivieren</Button>
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          </Card>

          <PersonaAndBrief
            persona={data.persona ?? ''}
            brief={data.brief}
            briefAt={data.briefAt}
            saving={persona.isPending}
            regenerating={brief.isPending}
            onSave={value => persona.mutate(value)}
            onRegenerate={() => brief.mutate()}
          />
        </>
      )}
    </div>
  );
}

function KnowledgeEditor({
  gameservers,
  initial,
  loading,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  gameservers: GameserverOption[];
  initial?: KnowledgeRow;
  loading: boolean;
  submitLabel: string;
  onSubmit: (value: { label: string; content: string; nitradoConnId: string | null }) => void;
  onCancel: () => void;
}) {
  const [label, setLabel] = useState(initial?.label ?? '');
  const [content, setContent] = useState(initial?.content ?? '');
  const [nitradoConnId, setNitradoConnId] = useState(initial?.scope.nitradoConnId ?? '');

  return (
    <div className="mb-4 space-y-3 rounded-lg border border-border bg-bg-elev p-4" data-testid="knowledge-scope-editor">
      <div className="grid gap-3 md:grid-cols-2">
        <label className="space-y-1">
          <span className="text-xs text-muted">Label</span>
          <Input value={label} onChange={event => setLabel(event.target.value)} maxLength={60} placeholder="z. B. Loot-Regeln" />
        </label>
        <label className="space-y-1">
          <span className="text-xs text-muted">Knowledge-Scope</span>
          <Select value={nitradoConnId} onChange={event => setNitradoConnId(event.target.value)} aria-label="Knowledge Gameserver Scope">
            <option value="">Guild-global</option>
            {gameservers.map(server => (
              <option key={server.id} value={server.id}>Slot {server.slot} · {server.alias || server.alias5}</option>
            ))}
          </Select>
        </label>
      </div>
      <label className="block space-y-1">
        <span className="text-xs text-muted">Faktenblock</span>
        <textarea
          value={content}
          onChange={event => setContent(event.target.value)}
          maxLength={2000}
          rows={5}
          className="input-premium min-h-28 w-full resize-y rounded-lg px-3.5 py-2.5 text-sm text-white placeholder:text-muted/80 focus:outline-none"
          placeholder="Verifizierte Fakten für diesen Scope"
        />
      </label>
      <p className="text-xs text-muted">Guild-global gilt für alle Gameserver dieser Guild. Ein Slot-Scope wird nur zusammen mit globalem Wissen für genau diesen Gameserver gerankt.</p>
      <div className="flex flex-wrap gap-2">
        <Button disabled={!label.trim() || !content.trim()} loading={loading} onClick={() => onSubmit({ label, content, nitradoConnId: nitradoConnId || null })}>{submitLabel}</Button>
        <Button variant="ghost" onClick={onCancel}>Abbrechen</Button>
      </div>
    </div>
  );
}

function KnowledgeImport({ loading, onSubmit, onCancel }: { loading: boolean; onSubmit: (items: ExportItem[]) => void; onCancel: () => void }) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);

  function submit(): void {
    setError(null);
    try {
      const parsed = JSON.parse(text) as ExportPayload | ExportItem[];
      const items = Array.isArray(parsed) ? parsed : parsed.items;
      if (!Array.isArray(items)) {
        setError('JSON muss ein Array oder ein exportiertes { items: [...] } enthalten.');
        return;
      }
      onSubmit(items);
    } catch {
      setError('Ungültiges JSON.');
    }
  }

  return (
    <div className="mb-4 space-y-3 rounded-lg border border-border bg-bg-elev p-4">
      <p className="text-xs text-muted">Portables Format: <code>scopeType</code> und <code>scopeSlot</code> werden beim Import gegen die aktuelle Guild validiert. Ungültige Slots werden übersprungen und niemals globalisiert.</p>
      <textarea
        value={text}
        onChange={event => setText(event.target.value)}
        rows={7}
        className="input-premium min-h-36 w-full resize-y rounded-lg px-3.5 py-2.5 font-mono text-sm text-white placeholder:text-muted/80 focus:outline-none"
        placeholder='{"items":[{"label":"...","content":"...","scopeType":"GAMESERVER","scopeSlot":1}]}'
      />
      {error && <p className="text-xs text-danger">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <Button disabled={!text.trim()} loading={loading} onClick={submit}>Importieren</Button>
        <Button variant="ghost" onClick={onCancel}>Abbrechen</Button>
      </div>
    </div>
  );
}

function PersonaAndBrief({
  persona,
  brief,
  briefAt,
  saving,
  regenerating,
  onSave,
  onRegenerate,
}: {
  persona: string;
  brief: string | null;
  briefAt: string | null;
  saving: boolean;
  regenerating: boolean;
  onSave: (value: string | null) => void;
  onRegenerate: () => void;
}) {
  const [text, setText] = useState(persona);
  const [loaded, setLoaded] = useState(persona);
  if (persona !== loaded) {
    setLoaded(persona);
    setText(persona);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Persona & Guild-Brief</CardTitle>
        <CardDesc>Diese Daten bleiben guild-global. Gameserver-spezifische Fakten gehören ausschließlich in gescoppte Snippets.</CardDesc>
      </CardHeader>
      <div className="space-y-4">
        <textarea
          value={text}
          onChange={event => setText(event.target.value)}
          maxLength={1500}
          rows={4}
          className="input-premium min-h-28 w-full resize-y rounded-lg px-3.5 py-2.5 text-sm text-white placeholder:text-muted/80 focus:outline-none"
          placeholder="Harmlose Stilpräferenz für die Persona"
        />
        <div className="flex flex-wrap gap-2">
          <Button loading={saving} onClick={() => onSave(text.trim() ? text.trim() : null)}>Persona speichern</Button>
          {persona && <Button variant="ghost" onClick={() => { setText(''); onSave(null); }}>Persona entfernen</Button>}
        </div>
        <div className="border-t border-border pt-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-medium text-white">AI-Brief</p>
              <p className="text-xs text-muted">{briefAt ? `Zuletzt: ${new Date(briefAt).toLocaleString('de-DE')}` : 'Noch nicht generiert.'}</p>
            </div>
            <Button variant="secondary" loading={regenerating} onClick={onRegenerate}>Neu generieren</Button>
          </div>
          {brief && <p className="mt-3 whitespace-pre-wrap break-words rounded-md border border-border bg-bg-elev p-3 text-xs text-muted">{brief}</p>}
        </div>
      </div>
    </Card>
  );
}
