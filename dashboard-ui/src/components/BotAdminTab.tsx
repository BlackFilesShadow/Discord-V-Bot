/**
 * Bot-Admin-Bereich — globaler, passwortgeschuetzter Support-Bereich.
 *
 * NICHT der DEV-Bereich. Buendelt die frueheren `/admin-*`-Discord-Commands als
 * Dashboard-Funktionen mit eigener Subnavigation (wie der DEV-Bereich).
 *
 * Backend: /api/v2/bot-admin/* (global). Zugriff wird ueber die
 * BotAdminSession (Passwort-Login, requireBotAdmin) freigeschaltet — eine
 * einzige Bot-Admin-Berechtigung schaltet alle Aktionen frei.
 *
 * Einige Sektionen sind serverbezogen (Selfroles, Feeds, Uebersetzungen, XP)
 * und erwarten eine guildId, die ueber den Server-Selektor gewaehlt wird.
 */
import { useState, type ReactNode, type ComponentType } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  LayoutDashboard, Gavel, MessageSquare, Megaphone, UploadCloud, Download, ShieldCheck,
  Package, Users, Ticket, Tags, Rss, Languages, TrendingUp, AlertOctagon,
  RefreshCw, Loader2, Inbox, Trash2, Power, KeyRound, X, AlertTriangle,
} from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Modal } from '@/components/ui/Modal';
import { Badge } from '@/components/ui/Badge';
import { EmptyState } from '@/components/ui/EmptyState';
import { useToast } from '@/components/ui/Toast';

type SectionKey =
  | 'overview' | 'appeals' | 'feedback' | 'broadcast' | 'upload' | 'export' | 'validate'
  | 'packages' | 'users' | 'tickets' | 'selfroles' | 'feeds' | 'translate' | 'xp' | 'danger';

interface SectionDef {
  key: SectionKey;
  label: string;
  icon: ComponentType<{ className?: string }>;
  desc: string;
  danger?: boolean;
}

const SECTIONS: ReadonlyArray<SectionDef> = [
  { key: 'overview', label: 'Übersicht', icon: LayoutDashboard, desc: 'Status & Schnellzugriffe' },
  { key: 'appeals', label: 'Appeals', icon: Gavel, desc: 'Einsprüche prüfen' },
  { key: 'feedback', label: 'Feedback', icon: MessageSquare, desc: 'Nutzer-Feedback' },
  { key: 'broadcast', label: 'Broadcast', icon: Megaphone, desc: 'Massen-DM' },
  { key: 'upload', label: 'Upload-Steuerung', icon: UploadCloud, desc: 'Uploads global schalten' },
  { key: 'export', label: 'Export', icon: Download, desc: 'Daten exportieren' },
  { key: 'validate', label: 'Validierung', icon: ShieldCheck, desc: 'Dateien prüfen' },
  { key: 'packages', label: 'Pakete', icon: Package, desc: 'Pakete verwalten' },
  { key: 'users', label: 'Nutzer', icon: Users, desc: 'Nutzer verwalten' },
  { key: 'tickets', label: 'Tickets', icon: Ticket, desc: 'Support-Tickets' },
  { key: 'selfroles', label: 'Selfroles', icon: Tags, desc: 'Self-Role-Menüs' },
  { key: 'feeds', label: 'Feeds', icon: Rss, desc: 'Feed-Quellen' },
  { key: 'translate', label: 'Übersetzungen', icon: Languages, desc: 'Posts übersetzen' },
  { key: 'xp', label: 'XP-System', icon: TrendingUp, desc: 'Level & Raten' },
  { key: 'danger', label: 'Gefahrenzone', icon: AlertOctagon, desc: 'Gefährliche Aktionen', danger: true },
];

// Sektionen, die einen ausgewaehlten Server (guildId) benoetigen.
const GUILD_SCOPED = new Set<SectionKey>(['selfroles', 'feeds', 'translate', 'xp']);

interface GuildOption { id: string; name: string; memberCount: number }

export function BotAdminTab() {
  const [section, setSection] = useState<SectionKey>('overview');
  const [guildId, setGuildId] = useState<string>('');
  const base = '/api/v2/bot-admin';
  const canManage = true;
  const canDanger = true;

  const guildsQ = useQuery({
    queryKey: [base, 'guilds'],
    queryFn: () => api.get<{ items: GuildOption[] }>(`${base}/guilds`),
  });
  const guilds = guildsQ.data?.items ?? [];
  const needsGuild = GUILD_SCOPED.has(section);

  return (
    <div className="grid gap-5 lg:grid-cols-[200px_1fr]">
      {/* Subnavigation */}
      <nav className="space-y-1 lg:sticky lg:top-4 self-start" aria-label="Bot-Admin-Bereiche">
        {SECTIONS.map(s => {
          const Icon = s.icon;
          const active = section === s.key;
          return (
            <button
              key={s.key}
              type="button"
              onClick={() => setSection(s.key)}
              className={`w-full flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium text-left transition-colors focus-ring ${
                active
                  ? (s.danger ? 'bg-danger/15 text-danger border border-danger/30' : 'bg-accent/15 text-accent border border-accent/30 shadow-glow-sm')
                  : 'text-muted hover:text-white hover:bg-bg-elev border border-transparent'
              }`}
              aria-current={active ? 'page' : undefined}
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span className="truncate">{s.label}</span>
            </button>
          );
        })}
      </nav>

      {/* Inhalt */}
      <div className="min-w-0">
        {needsGuild && (
          <div className="mb-4 flex items-center gap-2 flex-wrap">
            <span className="text-xs text-muted">Server:</span>
            <Select value={guildId} onChange={e => setGuildId(e.target.value)} className="!w-auto text-sm">
              <option value="">— Server wählen —</option>
              {guilds.map(g => <option key={g.id} value={g.id}>{g.name} ({g.memberCount})</option>)}
            </Select>
            {guildsQ.isFetching && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted" />}
          </div>
        )}
        {needsGuild && !guildId ? (
          <Card glow><EmptyState icon={Inbox} title="Server wählen" desc="Bitte oben einen Server auswählen, um diesen Bereich zu verwalten." /></Card>
        ) : (
          <>
            {section === 'overview' && <OverviewSection base={base} onJump={setSection} />}
            {section === 'appeals' && <AppealsSection base={base} canManage={canManage} />}
            {section === 'feedback' && <FeedbackSection base={base} canManage={canManage} />}
            {section === 'broadcast' && <BroadcastSection base={base} canManage={canManage} canDanger={canDanger} />}
            {section === 'upload' && <UploadSection base={base} canManage={canManage} />}
            {section === 'export' && <ExportSection base={base} canManage={canManage} canDanger={canDanger} />}
            {section === 'validate' && <ValidateSection base={base} canManage={canManage} />}
            {section === 'packages' && <PackagesSection base={base} canManage={canManage} canDanger={canDanger} />}
            {section === 'users' && <UsersSection base={base} canManage={canManage} canDanger={canDanger} />}
            {section === 'tickets' && <TicketsSection base={base} canManage={canManage} />}
            {section === 'selfroles' && <SelfrolesSection base={base} guildId={guildId} canManage={canManage} />}
            {section === 'feeds' && <FeedsSection base={base} guildId={guildId} canManage={canManage} />}
            {section === 'translate' && <TranslateSection base={base} guildId={guildId} canManage={canManage} />}
            {section === 'xp' && <XpSection base={base} guildId={guildId} canManage={canManage} />}
            {section === 'danger' && <DangerSection base={base} canDanger={canDanger} />}
          </>
        )}
      </div>
    </div>
  );
}

// ── gemeinsame Helfer ───────────────────────────────────────────────────────
function SectionHeader({ title, desc, onRefresh, loading, action }: { title: string; desc?: string; onRefresh?: () => void; loading?: boolean; action?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 mb-4">
      <div>
        <h2 className="text-lg font-semibold text-white">{title}</h2>
        {desc && <p className="text-muted text-sm mt-0.5">{desc}</p>}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {action}
        {onRefresh && (
          <Button size="sm" variant="ghost" onClick={onRefresh} disabled={loading} aria-label="Aktualisieren">
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          </Button>
        )}
      </div>
    </div>
  );
}

function errMsg(e: unknown): string {
  return e instanceof ApiError ? e.message : (e as Error)?.message ?? 'Unbekannter Fehler';
}

function ReadOnlyHint({ canManage }: { canManage: boolean }) {
  if (canManage) return null;
  return (
    <p className="text-xs text-muted mb-3 inline-flex items-center gap-1">
      <ShieldCheck className="h-3 w-3" /> Nur-Lesen-Modus — für Aktionen ist eine aktive Bot-Admin-Session erforderlich.
    </p>
  );
}

function ConfirmDialog({ open, title, desc, confirmLabel, danger, requireType, onConfirm, onClose, loading }: {
  open: boolean; title: string; desc?: string; confirmLabel: string; danger?: boolean;
  requireType?: string; onConfirm: () => void; onClose: () => void; loading?: boolean;
}) {
  const [typed, setTyped] = useState('');
  const ok = !requireType || typed === requireType;
  return (
    <Modal open={open} onClose={onClose} title={title} desc={desc} preventBackdropClose
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>Abbrechen</Button>
          <Button variant={danger ? 'danger' : 'primary'} size="sm" onClick={onConfirm} disabled={!ok || loading} loading={loading}>{confirmLabel}</Button>
        </>
      }
    >
      {requireType && (
        <div>
          <p className="text-sm text-muted mb-2">Zur Bestätigung <code className="text-danger font-bold">{requireType}</code> eingeben:</p>
          <Input value={typed} onChange={e => setTyped(e.target.value)} placeholder={requireType} autoFocus />
        </div>
      )}
    </Modal>
  );
}

// ════════════════════════════════════════════════════════════════════════
// ÜBERSICHT
// ════════════════════════════════════════════════════════════════════════
interface OverviewData {
  stats: { openAppeals: number; newFeedback: number; pendingValidations: number; uploadEnabled: boolean; suspendedUsers: number; deletedPackages: number; criticalWarnings: number };
  recentBroadcasts: Array<{ id: string; details: unknown; createdAt: string }>;
  recentExports: Array<{ id: string; action: string; details: unknown; createdAt: string }>;
  recentAdminActions: Array<{ id: string; action: string; createdAt: string }>;
}

function OverviewSection({ base, onJump }: { base: string; onJump: (s: SectionKey) => void }) {
  const q = useQuery({ queryKey: [base, 'overview'], queryFn: () => api.get<OverviewData>(`${base}/overview`) });
  const s = q.data?.stats;
  const stat = (label: string, value: ReactNode, jump: SectionKey, danger?: boolean) => (
    <button type="button" onClick={() => onJump(jump)} className="text-left">
      <Card className="!p-4 hover:border-accent/40 transition-colors h-full">
        <p className="text-xs text-muted">{label}</p>
        <p className={`text-2xl font-bold mt-1 ${danger ? 'text-danger' : 'text-white'}`}>{value}</p>
      </Card>
    </button>
  );
  return (
    <Card glow>
      <SectionHeader title="Übersicht" desc="Aktueller Status des Bot-Admin-Bereichs" onRefresh={() => q.refetch()} loading={q.isFetching} />
      {q.isError && <p className="text-danger text-sm">{errMsg(q.error)}</p>}
      {q.isLoading && <div className="h-24 rounded-xl skeleton" />}
      {s && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {stat('Offene Appeals', s.openAppeals, 'appeals')}
            {stat('Neues Feedback', s.newFeedback, 'feedback')}
            {stat('Ausstehende Validierungen', s.pendingValidations, 'validate')}
            {stat('Upload-Status', s.uploadEnabled ? 'AN' : 'AUS', 'upload', !s.uploadEnabled)}
            {stat('Gesperrte Nutzer', s.suspendedUsers, 'users')}
            {stat('Gelöschte Pakete', s.deletedPackages, 'packages')}
            {stat('Kritische Warnungen', s.criticalWarnings, 'danger', s.criticalWarnings > 0)}
          </div>
          <div className="grid gap-4 md:grid-cols-3 mt-5">
            <RecentList title="Letzte Broadcasts" items={q.data!.recentBroadcasts.map(b => ({ id: b.id, text: new Date(b.createdAt).toLocaleString('de-DE') }))} />
            <RecentList title="Letzte Exporte" items={q.data!.recentExports.map(b => ({ id: b.id, text: `${b.action.replace('BOTADMIN_EXPORT_', '')} · ${new Date(b.createdAt).toLocaleString('de-DE')}` }))} />
            <RecentList title="Letzte Admin-Aktionen" items={q.data!.recentAdminActions.map(b => ({ id: b.id, text: `${b.action.replace('BOTADMIN_', '')} · ${new Date(b.createdAt).toLocaleString('de-DE')}` }))} />
          </div>
        </>
      )}
    </Card>
  );
}

function RecentList({ title, items }: { title: string; items: Array<{ id: string; text: string }> }) {
  return (
    <div>
      <h3 className="text-sm font-semibold text-white mb-2">{title}</h3>
      {items.length === 0 ? (
        <p className="text-xs text-muted">Keine Einträge.</p>
      ) : (
        <ul className="space-y-1">
          {items.slice(0, 6).map(i => <li key={i.id} className="text-xs text-muted truncate">{i.text}</li>)}
        </ul>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════
// APPEALS
// ════════════════════════════════════════════════════════════════════════
interface AppealRow { id: string; reason: string; status: string; reviewNote: string | null; createdAt: string; user: { username: string; discordId: string }; case: { reason: string | null; action: string | null } }

function AppealsSection({ base, canManage }: { base: string; canManage: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [status, setStatus] = useState('PENDING');
  const [decide, setDecide] = useState<AppealRow | null>(null);
  const q = useQuery({ queryKey: [base, 'appeals', status], queryFn: () => api.get<{ items: AppealRow[]; total: number }>(`${base}/appeals?status=${status}`) });

  const decision = useMutation({
    mutationFn: (vars: { id: string; decision: string; note: string }) => api.post(`${base}/appeals/${vars.id}/decision`, { decision: vars.decision, note: vars.note }),
    onSuccess: () => { toast.success('Appeal aktualisiert.'); qc.invalidateQueries({ queryKey: [base, 'appeals'] }); setDecide(null); },
    onError: e => toast.error(errMsg(e)),
  });

  return (
    <Card glow>
      <SectionHeader title="Appeals" desc="Einsprüche gegen Moderationsfälle (früher /admin-appeals)" onRefresh={() => q.refetch()} loading={q.isFetching}
        action={<Select value={status} onChange={e => setStatus(e.target.value)} className="!w-auto text-sm"><option value="PENDING">Offen</option><option value="APPROVED">Genehmigt</option><option value="DENIED">Abgelehnt</option><option value="ESCALATED">Eskaliert</option></Select>} />
      <ReadOnlyHint canManage={canManage} />
      {q.isError && <p className="text-danger text-sm">{errMsg(q.error)}</p>}
      {q.data && q.data.items.length === 0 && <EmptyState icon={Inbox} title="Keine Appeals" desc="In diesem Status gibt es keine Einsprüche." />}
      <div className="space-y-2">
        {q.data?.items.map(a => (
          <Card key={a.id} className="!p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-semibold text-white">{a.user.username}</span>
                  <Badge variant={a.status === 'PENDING' ? 'warn' : a.status === 'APPROVED' ? 'ok' : 'danger'}>{a.status}</Badge>
                </div>
                <p className="text-sm text-muted mt-1">{a.reason}</p>
                {a.case.action && <p className="text-xs text-muted mt-0.5">Fall: {a.case.action} — {a.case.reason}</p>}
              </div>
              {canManage && a.status === 'PENDING' && (
                <Button size="sm" onClick={() => setDecide(a)}>Entscheiden</Button>
              )}
            </div>
          </Card>
        ))}
      </div>
      {decide && <AppealDecideModal appeal={decide} onClose={() => setDecide(null)} onSubmit={(d, n) => decision.mutate({ id: decide.id, decision: d, note: n })} loading={decision.isPending} />}
    </Card>
  );
}

function AppealDecideModal({ appeal, onClose, onSubmit, loading }: { appeal: AppealRow; onClose: () => void; onSubmit: (decision: string, note: string) => void; loading: boolean }) {
  const [note, setNote] = useState('');
  const [decision, setDecision] = useState('APPROVED');
  return (
    <Modal open onClose={onClose} title={`Appeal: ${appeal.user.username}`} desc={appeal.reason}
      footer={<><Button variant="ghost" size="sm" onClick={onClose}>Abbrechen</Button><Button size="sm" loading={loading} onClick={() => onSubmit(decision, note)}>Bestätigen</Button></>}>
      <Select value={decision} onChange={e => setDecision(e.target.value)}><option value="APPROVED">Genehmigen</option><option value="DENIED">Ablehnen</option><option value="ESCALATED">Eskalieren</option></Select>
      <textarea value={note} onChange={e => setNote(e.target.value)} maxLength={1000} placeholder="Notiz (optional)" className="w-full mt-2 rounded-md bg-bg-elev border border-border px-3 py-2 text-sm text-white" rows={3} />
    </Modal>
  );
}

// ════════════════════════════════════════════════════════════════════════
// FEEDBACK
// ════════════════════════════════════════════════════════════════════════
interface FeedbackRow { id: string; category: string; subject: string; message: string; status: string; username: string; adminNote: string | null; createdAt: string }

function FeedbackSection({ base, canManage }: { base: string; canManage: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [status, setStatus] = useState('OPEN');
  const [edit, setEdit] = useState<FeedbackRow | null>(null);
  const q = useQuery({ queryKey: [base, 'feedback', status], queryFn: () => api.get<{ items: FeedbackRow[] }>(`${base}/feedback?status=${status}`) });
  const update = useMutation({
    mutationFn: (vars: { id: string; status: string; adminNote: string }) => api.patch(`${base}/feedback/${vars.id}`, { status: vars.status, adminNote: vars.adminNote }),
    onSuccess: () => { toast.success('Feedback aktualisiert.'); qc.invalidateQueries({ queryKey: [base, 'feedback'] }); setEdit(null); },
    onError: e => toast.error(errMsg(e)),
  });
  return (
    <Card glow>
      <SectionHeader title="Feedback" desc="Nutzer-Feedback (früher /admin-feedback)" onRefresh={() => q.refetch()} loading={q.isFetching}
        action={<Select value={status} onChange={e => setStatus(e.target.value)} className="!w-auto text-sm"><option value="OPEN">Offen</option><option value="IN_REVIEW">In Prüfung</option><option value="RESOLVED">Erledigt</option><option value="WONTFIX">Verworfen</option></Select>} />
      <ReadOnlyHint canManage={canManage} />
      {q.isError && <p className="text-danger text-sm">{errMsg(q.error)}</p>}
      {q.data && q.data.items.length === 0 && <EmptyState icon={Inbox} title="Kein Feedback" desc="Keine Einträge in diesem Status." />}
      <div className="space-y-2">
        {q.data?.items.map(f => (
          <Card key={f.id} className="!p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge variant="info">{f.category}</Badge>
                  <span className="font-semibold text-white truncate">{f.subject}</span>
                  <Badge variant={f.status === 'OPEN' ? 'warn' : f.status === 'RESOLVED' ? 'ok' : 'neutral'}>{f.status}</Badge>
                </div>
                <p className="text-sm text-muted mt-1">{f.message}</p>
                <p className="text-xs text-muted mt-0.5">von {f.username} · {new Date(f.createdAt).toLocaleString('de-DE')}</p>
              </div>
              {canManage && <Button size="sm" variant="secondary" onClick={() => setEdit(f)}>Bearbeiten</Button>}
            </div>
          </Card>
        ))}
      </div>
      {edit && <FeedbackEditModal fb={edit} onClose={() => setEdit(null)} onSubmit={(st, note) => update.mutate({ id: edit.id, status: st, adminNote: note })} loading={update.isPending} />}
    </Card>
  );
}

function FeedbackEditModal({ fb, onClose, onSubmit, loading }: { fb: FeedbackRow; onClose: () => void; onSubmit: (status: string, note: string) => void; loading: boolean }) {
  const [status, setStatus] = useState(fb.status);
  const [note, setNote] = useState(fb.adminNote ?? '');
  return (
    <Modal open onClose={onClose} title={fb.subject} desc={fb.message}
      footer={<><Button variant="ghost" size="sm" onClick={onClose}>Abbrechen</Button><Button size="sm" loading={loading} onClick={() => onSubmit(status, note)}>Speichern</Button></>}>
      <Select value={status} onChange={e => setStatus(e.target.value)}><option value="OPEN">Offen</option><option value="IN_REVIEW">In Prüfung</option><option value="RESOLVED">Erledigt</option><option value="WONTFIX">Verworfen</option></Select>
      <textarea value={note} onChange={e => setNote(e.target.value)} maxLength={2000} placeholder="Admin-Notiz" className="w-full mt-2 rounded-md bg-bg-elev border border-border px-3 py-2 text-sm text-white" rows={3} />
    </Modal>
  );
}

// ════════════════════════════════════════════════════════════════════════
// BROADCAST
// ════════════════════════════════════════════════════════════════════════
function BroadcastSection({ base, canManage, canDanger }: { base: string; canManage: boolean; canDanger: boolean }) {
  const toast = useToast();
  const [target, setTarget] = useState('MANUFACTURER');
  const [message, setMessage] = useState('');
  const [confirm, setConfirm] = useState(false);
  const q = useQuery({ queryKey: [base, 'broadcast'], queryFn: () => api.get<{ recent: Array<{ id: string; createdAt: string }> }>(`${base}/broadcast`) });
  const send = useMutation({
    mutationFn: (dryRun: boolean) => api.post<{ recipients: number; sent?: number; failed?: number; dryRun?: boolean }>(`${base}/broadcast`, { target, message, dryRun }),
    onSuccess: (r) => { if (r.dryRun) toast.info(`${r.recipients} Empfänger (Probelauf).`); else { toast.success(`Gesendet: ${r.sent}, Fehlgeschlagen: ${r.failed}.`); setMessage(''); } setConfirm(false); q.refetch(); },
    onError: e => { toast.error(errMsg(e)); setConfirm(false); },
  });
  const isAll = target === 'ALL';
  const blocked = isAll && !canDanger;
  return (
    <Card glow>
      <SectionHeader title="Broadcast" desc="Massen-DM an Nutzergruppen (früher /admin-broadcast)" onRefresh={() => q.refetch()} loading={q.isFetching} />
      <ReadOnlyHint canManage={canManage} />
      <div className="space-y-3 max-w-xl">
        <Select value={target} onChange={e => setTarget(e.target.value)} disabled={!canManage}>
          <option value="MANUFACTURER">Hersteller</option>
          <option value="ADMIN">Admins</option>
          <option value="MODERATOR">Moderatoren</option>
          <option value="ALL">ALLE (gefährlich)</option>
        </Select>
        {isAll && (
          <p className="text-xs text-warn inline-flex items-center gap-1"><AlertTriangle className="h-3 w-3" /> Broadcast an ALLE Nutzer — bitte mit Bedacht einsetzen.</p>
        )}
        <textarea value={message} onChange={e => setMessage(e.target.value)} maxLength={1900} placeholder="Nachricht (max. 1900 Zeichen)" disabled={!canManage} className="w-full rounded-md bg-bg-elev border border-border px-3 py-2 text-sm text-white" rows={5} />
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" disabled={!canManage || !message.trim() || blocked} onClick={() => send.mutate(true)} loading={send.isPending}>Probelauf</Button>
          <Button size="sm" disabled={!canManage || !message.trim() || blocked} onClick={() => setConfirm(true)}>Senden</Button>
        </div>
      </div>
      <ConfirmDialog open={confirm} title="Broadcast senden" desc={`Nachricht an Gruppe „${target}" senden?`} confirmLabel="Senden" danger={isAll}
        onConfirm={() => send.mutate(false)} onClose={() => setConfirm(false)} loading={send.isPending} />
    </Card>
  );
}

// ════════════════════════════════════════════════════════════════════════
// UPLOAD-STEUERUNG
// ════════════════════════════════════════════════════════════════════════
function UploadSection({ base, canManage }: { base: string; canManage: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: [base, 'upload'], queryFn: () => api.get<{ enabled: boolean; maxSize: number; allowedTypes: string[] }>(`${base}/upload`) });
  const toggle = useMutation({
    mutationFn: (enable: boolean) => api.post(`${base}/upload/toggle`, { enable }),
    onSuccess: () => { toast.success('Upload-Status aktualisiert.'); qc.invalidateQueries({ queryKey: [base, 'upload'] }); },
    onError: e => toast.error(errMsg(e)),
  });
  return (
    <Card glow>
      <SectionHeader title="Upload-Steuerung" desc="Globaler Upload-Schalter" onRefresh={() => q.refetch()} loading={q.isFetching} />
      <ReadOnlyHint canManage={canManage} />
      {q.data && (
        <div className="space-y-3 max-w-md">
          <div className="flex items-center justify-between p-3 rounded-md bg-bg-elev border border-border">
            <div>
              <p className="font-medium text-white">Uploads {q.data.enabled ? 'aktiviert' : 'deaktiviert'}</p>
              <p className="text-xs text-muted">Erlaubte Typen: {q.data.allowedTypes.join(', ')}</p>
            </div>
            <Badge variant={q.data.enabled ? 'ok' : 'danger'}>{q.data.enabled ? 'AN' : 'AUS'}</Badge>
          </div>
          {canManage && (
            <Button size="sm" variant={q.data.enabled ? 'danger' : 'primary'} onClick={() => toggle.mutate(!q.data!.enabled)} loading={toggle.isPending}>
              <Power className="h-4 w-4 mr-1" /> {q.data.enabled ? 'Uploads deaktivieren' : 'Uploads aktivieren'}
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}

// ════════════════════════════════════════════════════════════════════════
// EXPORT
// ════════════════════════════════════════════════════════════════════════
function ExportSection({ base, canManage, canDanger }: { base: string; canManage: boolean; canDanger: boolean }) {
  const toast = useToast();
  const run = useMutation({
    mutationFn: (type: string) => api.post<{ type: string; rows: number; data: unknown[] }>(`${base}/export`, { type }),
    onSuccess: (r) => {
      const blob = new Blob([JSON.stringify(r.data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = `export-${r.type}-${Date.now()}.json`; a.click();
      URL.revokeObjectURL(url);
      toast.success(`${r.rows} Datensätze exportiert.`);
    },
    onError: e => toast.error(errMsg(e)),
  });
  return (
    <Card glow>
      <SectionHeader title="Export" desc="Daten als JSON exportieren (früher /admin-export)" />
      <ReadOnlyHint canManage={canManage} />
      <div className="grid gap-3 sm:grid-cols-3 max-w-2xl">
        <ExportBtn label="Pakete" disabled={!canManage} onClick={() => run.mutate('packages')} loading={run.isPending} />
        <ExportBtn label="Audit-Logs" disabled={!canManage} onClick={() => run.mutate('logs')} loading={run.isPending} />
        <ExportBtn label="Nutzer (GDPR)" danger disabled={!canDanger} hint={!canDanger ? 'Bot-Admin-Session nötig' : undefined} onClick={() => run.mutate('users')} loading={run.isPending} />
      </div>
    </Card>
  );
}

function ExportBtn({ label, danger, disabled, hint, onClick, loading }: { label: string; danger?: boolean; disabled?: boolean; hint?: string; onClick: () => void; loading?: boolean }) {
  return (
    <Card className="!p-4 text-center">
      <p className={`font-medium ${danger ? 'text-danger' : 'text-white'} mb-2`}>{label}</p>
      <Button size="sm" variant={danger ? 'danger' : 'secondary'} disabled={disabled || loading} onClick={onClick} loading={loading}><Download className="h-4 w-4 mr-1" /> Export</Button>
      {hint && <p className="text-[11px] text-muted mt-2">{hint}</p>}
    </Card>
  );
}

// ════════════════════════════════════════════════════════════════════════
// VALIDIERUNG
// ════════════════════════════════════════════════════════════════════════
interface ValidationRow { id: string; isValid: boolean; createdAt: string; upload: { fileName: string; originalName: string } | null }

function ValidateSection({ base, canManage }: { base: string; canManage: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [uploadId, setUploadId] = useState('');
  const q = useQuery({ queryKey: [base, 'validate'], queryFn: () => api.get<{ pendingUploads: number; items: ValidationRow[] }>(`${base}/validate`) });
  const validate = useMutation({
    mutationFn: (id: string) => api.post<{ report: { isValid: boolean } }>(`${base}/validate`, { uploadId: id }),
    onSuccess: (r) => { toast[r.report.isValid ? 'success' : 'warn'](r.report.isValid ? 'Datei gültig.' : 'Datei ungültig.'); setUploadId(''); qc.invalidateQueries({ queryKey: [base, 'validate'] }); },
    onError: e => toast.error(errMsg(e)),
  });
  return (
    <Card glow>
      <SectionHeader title="Validierung" desc="Datei-Validierung (früher /admin-validate)" onRefresh={() => q.refetch()} loading={q.isFetching} />
      <ReadOnlyHint canManage={canManage} />
      {q.data && <p className="text-sm text-muted mb-3">Ausstehende Uploads: <span className="text-white font-semibold">{q.data.pendingUploads}</span></p>}
      {canManage && (
        <div className="flex gap-2 max-w-xl mb-4">
          <Input value={uploadId} onChange={e => setUploadId(e.target.value)} placeholder="Upload-ID" />
          <Button size="sm" disabled={!uploadId.trim()} onClick={() => validate.mutate(uploadId.trim())} loading={validate.isPending}>Validieren</Button>
        </div>
      )}
      <div className="space-y-2">
        {q.data?.items.map(v => (
          <div key={v.id} className="flex items-center justify-between p-2 rounded-md bg-bg-elev border border-border">
            <span className="text-sm text-muted truncate">{v.upload?.originalName ?? v.upload?.fileName ?? '—'}</span>
            <Badge variant={v.isValid ? 'ok' : 'danger'}>{v.isValid ? 'gültig' : 'ungültig'}</Badge>
          </div>
        ))}
      </div>
    </Card>
  );
}

// ════════════════════════════════════════════════════════════════════════
// PAKETE
// ════════════════════════════════════════════════════════════════════════
interface PackageRow { id: string; name: string; status: string; isDeleted: boolean; totalSize: string; fileCount: number; downloadCount: number; user: { username: string } }

function PackagesSection({ base, canManage, canDanger }: { base: string; canManage: boolean; canDanger: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [status, setStatus] = useState('');
  const [qstr, setQstr] = useState('');
  const [del, setDel] = useState<PackageRow | null>(null);
  const q = useQuery({ queryKey: [base, 'packages', status, qstr], queryFn: () => api.get<{ items: PackageRow[]; total: number }>(`${base}/packages?status=${status}&q=${encodeURIComponent(qstr)}`) });
  const setStatusM = useMutation({
    mutationFn: (vars: { id: string; status: string }) => api.post(`${base}/packages/${vars.id}/status`, { status: vars.status }),
    onSuccess: () => { toast.success('Status aktualisiert.'); qc.invalidateQueries({ queryKey: [base, 'packages'] }); }, onError: e => toast.error(errMsg(e)),
  });
  const restore = useMutation({
    mutationFn: (id: string) => api.post(`${base}/packages/${id}/restore`),
    onSuccess: () => { toast.success('Wiederhergestellt.'); qc.invalidateQueries({ queryKey: [base, 'packages'] }); }, onError: e => toast.error(errMsg(e)),
  });
  const remove = useMutation({
    mutationFn: (vars: { id: string; hard: boolean }) => api.del(`${base}/packages/${vars.id}${vars.hard ? '?hard=true' : ''}`),
    onSuccess: () => { toast.success('Gelöscht.'); qc.invalidateQueries({ queryKey: [base, 'packages'] }); setDel(null); }, onError: e => { toast.error(errMsg(e)); setDel(null); },
  });
  return (
    <Card glow>
      <SectionHeader title="Pakete" desc="Pakete verwalten (früher /admin-list-pakete & co.)" onRefresh={() => q.refetch()} loading={q.isFetching}
        action={<Select value={status} onChange={e => setStatus(e.target.value)} className="!w-auto text-sm"><option value="">Alle</option><option value="ACTIVE">Aktiv</option><option value="QUARANTINED">Quarantäne</option><option value="DELETED">Gelöscht</option><option value="VALIDATING">Validierung</option></Select>} />
      <ReadOnlyHint canManage={canManage} />
      <div className="max-w-xs mb-3"><Input value={qstr} onChange={e => setQstr(e.target.value)} placeholder="Name suchen…" /></div>
      {q.data && q.data.items.length === 0 && <EmptyState icon={Inbox} title="Keine Pakete" />}
      <div className="space-y-2">
        {q.data?.items.map(p => (
          <Card key={p.id} className="!p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-semibold text-white truncate">{p.name}</span>
                  <Badge variant={p.status === 'ACTIVE' ? 'ok' : p.status === 'QUARANTINED' ? 'warn' : 'danger'}>{p.status}</Badge>
                </div>
                <p className="text-xs text-muted mt-0.5">{p.user.username} · {p.fileCount} Dateien · {p.downloadCount} Downloads</p>
              </div>
              {canManage && (
                <div className="flex gap-1 shrink-0 flex-wrap justify-end">
                  {p.status !== 'ACTIVE' && !p.isDeleted && <Button size="sm" variant="secondary" onClick={() => setStatusM.mutate({ id: p.id, status: 'ACTIVE' })}>Freigeben</Button>}
                  {p.status !== 'QUARANTINED' && !p.isDeleted && <Button size="sm" variant="ghost" onClick={() => setStatusM.mutate({ id: p.id, status: 'QUARANTINED' })}>Quarantäne</Button>}
                  {p.isDeleted && <Button size="sm" variant="secondary" onClick={() => restore.mutate(p.id)}>Wiederherstellen</Button>}
                  {canDanger && <Button size="sm" variant="danger" onClick={() => setDel(p)} aria-label="Löschen"><Trash2 className="h-4 w-4" /></Button>}
                </div>
              )}
            </div>
          </Card>
        ))}
      </div>
      {del && <ConfirmDialog open title={`Paket „${del.name}" löschen`} desc={del.isDeleted ? 'Endgültig (hart) löschen? Nicht umkehrbar.' : 'Paket in den Papierkorb (Soft-Delete) verschieben.'} confirmLabel="Löschen" danger requireType={del.isDeleted ? 'DELETE' : undefined}
        onConfirm={() => remove.mutate({ id: del.id, hard: del.isDeleted })} onClose={() => setDel(null)} loading={remove.isPending} />}
    </Card>
  );
}

// ════════════════════════════════════════════════════════════════════════
// NUTZER
// ════════════════════════════════════════════════════════════════════════
interface UserRow { id: string; discordId: string; username: string; role: string; status: string; isManufacturer: boolean; createdAt: string }

function UsersSection({ base, canManage, canDanger }: { base: string; canManage: boolean; canDanger: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [filter, setFilter] = useState('ALL');
  const [qstr, setQstr] = useState('');
  const [reset, setReset] = useState<UserRow | null>(null);
  const [otp, setOtp] = useState<string | null>(null);
  const q = useQuery({ queryKey: [base, 'users', filter, qstr], queryFn: () => api.get<{ items: UserRow[]; total: number }>(`${base}/users?filter=${filter}&q=${encodeURIComponent(qstr)}`) });
  const toggleUpload = useMutation({
    mutationFn: (vars: { id: string; enable: boolean }) => api.post(`${base}/users/${vars.id}/toggle-upload`, { enable: vars.enable }),
    onSuccess: () => { toast.success('Nutzer aktualisiert.'); qc.invalidateQueries({ queryKey: [base, 'users'] }); }, onError: e => toast.error(errMsg(e)),
  });
  const manufacturer = useMutation({
    mutationFn: (vars: { id: string; decision: string }) => api.post<{ otp?: string }>(`${base}/users/${vars.id}/manufacturer`, { decision: vars.decision }),
    onSuccess: (r) => { toast.success('Aktualisiert.'); if (r.otp) setOtp(r.otp); qc.invalidateQueries({ queryKey: [base, 'users'] }); }, onError: e => toast.error(errMsg(e)),
  });
  const resetPw = useMutation({
    mutationFn: (vars: { id: string; expiryMinutes: number }) => api.post<{ otp: string }>(`${base}/users/${vars.id}/reset-password`, { expiryMinutes: vars.expiryMinutes }),
    onSuccess: (r) => { setOtp(r.otp); setReset(null); toast.success('Passwort zurückgesetzt.'); }, onError: e => { toast.error(errMsg(e)); setReset(null); },
  });
  return (
    <Card glow>
      <SectionHeader title="Nutzer" desc="Nutzerverwaltung (früher /admin-list-users & co.)" onRefresh={() => q.refetch()} loading={q.isFetching}
        action={<Select value={filter} onChange={e => setFilter(e.target.value)} className="!w-auto text-sm"><option value="ALL">Alle</option><option value="MANUFACTURER">Hersteller</option><option value="ADMIN">Admins</option><option value="MODERATOR">Moderatoren</option><option value="BANNED">Gebannt</option><option value="PENDING_VERIFICATION">Unverifiziert</option></Select>} />
      <ReadOnlyHint canManage={canManage} />
      <div className="max-w-xs mb-3"><Input value={qstr} onChange={e => setQstr(e.target.value)} placeholder="Name oder Discord-ID…" /></div>
      {q.data && q.data.items.length === 0 && <EmptyState icon={Inbox} title="Keine Nutzer" />}
      <div className="space-y-2">
        {q.data?.items.map(u => (
          <Card key={u.id} className="!p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-semibold text-white truncate">{u.username}</span>
                  <Badge variant="info">{u.role}</Badge>
                  <Badge variant={u.status === 'ACTIVE' ? 'ok' : u.status === 'SUSPENDED' ? 'warn' : 'danger'}>{u.status}</Badge>
                  {u.isManufacturer && <Badge variant="neutral">Hersteller</Badge>}
                </div>
                <p className="text-[11px] text-muted mt-0.5 font-mono">{u.discordId}</p>
              </div>
              {canManage && (
                <div className="flex gap-1 shrink-0 flex-wrap justify-end">
                  <Button size="sm" variant={u.status === 'SUSPENDED' ? 'secondary' : 'ghost'} onClick={() => toggleUpload.mutate({ id: u.id, enable: u.status === 'SUSPENDED' })}>{u.status === 'SUSPENDED' ? 'Entsperren' : 'Sperren'}</Button>
                  {!u.isManufacturer && <Button size="sm" variant="ghost" onClick={() => manufacturer.mutate({ id: u.id, decision: 'APPROVE' })}>Hersteller +</Button>}
                  {!u.isManufacturer && <Button size="sm" variant="ghost" onClick={() => manufacturer.mutate({ id: u.id, decision: 'DENY' })}>Ablehnen</Button>}
                  {canDanger && <Button size="sm" variant="danger" onClick={() => setReset(u)} aria-label="Passwort zurücksetzen"><KeyRound className="h-4 w-4" /></Button>}
                </div>
              )}
            </div>
          </Card>
        ))}
      </div>
      {reset && <ResetPasswordModal user={reset} onClose={() => setReset(null)} onSubmit={(min) => resetPw.mutate({ id: reset.id, expiryMinutes: min })} loading={resetPw.isPending} />}
      {otp && <OtpModal otp={otp} onClose={() => setOtp(null)} />}
    </Card>
  );
}

function ResetPasswordModal({ user, onClose, onSubmit, loading }: { user: UserRow; onClose: () => void; onSubmit: (expiryMinutes: number) => void; loading: boolean }) {
  const [minutes, setMinutes] = useState(30);
  const clamped = Math.min(1440, Math.max(5, minutes || 30));
  return (
    <Modal open onClose={onClose} title={`Passwort zurücksetzen: ${user.username}`} desc="Erzeugt ein neues Einmal-Passwort und widerruft alte."
      footer={<><Button variant="ghost" size="sm" onClick={onClose}>Abbrechen</Button><Button size="sm" variant="danger" loading={loading} onClick={() => onSubmit(clamped)}>Zurücksetzen</Button></>}>
      <label className="text-xs text-muted">Ablaufzeit (Minuten, 5–1440)</label>
      <Input type="number" min={5} max={1440} value={minutes} onChange={e => setMinutes(parseInt(e.target.value, 10) || 30)} className="mt-1" />
    </Modal>
  );
}

function OtpModal({ otp, onClose }: { otp: string; onClose: () => void }) {
  const toast = useToast();
  return (
    <Modal open onClose={onClose} title="Einmal-Passwort" desc="Nur jetzt sichtbar — sicher an den Nutzer weitergeben."
      footer={<Button size="sm" onClick={onClose}>Schließen</Button>}>
      <div className="flex items-center gap-2">
        <code className="flex-1 break-all bg-bg-elev border border-border rounded px-3 py-2 text-sm text-white">{otp}</code>
        <Button size="sm" variant="secondary" onClick={() => { void navigator.clipboard.writeText(otp); toast.success('Kopiert.'); }}>Kopieren</Button>
      </div>
    </Modal>
  );
}

// ════════════════════════════════════════════════════════════════════════
// TICKETS
// ════════════════════════════════════════════════════════════════════════
interface TicketRow { id: string; ticketNumber: number; username: string; subject: string; status: string; createdAt: string }

function TicketsSection({ base, canManage }: { base: string; canManage: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [status, setStatus] = useState('OPEN');
  const q = useQuery({ queryKey: [base, 'tickets', status], queryFn: () => api.get<{ items: TicketRow[] }>(`${base}/tickets?status=${status}`) });
  const close = useMutation({
    mutationFn: (id: string) => api.post(`${base}/tickets/${id}/close`),
    onSuccess: () => { toast.success('Ticket geschlossen.'); qc.invalidateQueries({ queryKey: [base, 'tickets'] }); }, onError: e => toast.error(errMsg(e)),
  });
  return (
    <Card glow>
      <SectionHeader title="Tickets" desc="Support-Tickets (früher /admin-tickets)" onRefresh={() => q.refetch()} loading={q.isFetching}
        action={<Select value={status} onChange={e => setStatus(e.target.value)} className="!w-auto text-sm"><option value="PENDING">Wartend</option><option value="OPEN">Offen</option><option value="CLOSED">Geschlossen</option><option value="DENIED">Abgelehnt</option></Select>} />
      <ReadOnlyHint canManage={canManage} />
      {q.data && q.data.items.length === 0 && <EmptyState icon={Inbox} title="Keine Tickets" />}
      <div className="space-y-2">
        {q.data?.items.map(t => (
          <Card key={t.id} className="!p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono text-xs text-muted">#{t.ticketNumber}</span>
                  <span className="font-semibold text-white truncate">{t.subject}</span>
                  <Badge variant={t.status === 'OPEN' ? 'ok' : t.status === 'PENDING' ? 'warn' : 'neutral'}>{t.status}</Badge>
                </div>
                <p className="text-xs text-muted mt-0.5">{t.username} · {new Date(t.createdAt).toLocaleString('de-DE')}</p>
              </div>
              {canManage && (t.status === 'OPEN' || t.status === 'PENDING') && <Button size="sm" variant="secondary" onClick={() => close.mutate(t.id)}>Schließen</Button>}
            </div>
          </Card>
        ))}
      </div>
    </Card>
  );
}

// ════════════════════════════════════════════════════════════════════════
// SELFROLES
// ════════════════════════════════════════════════════════════════════════
interface SelfRoleOpt { id: string; roleId: string; label: string }
interface SelfRoleMenuRow { id: string; title: string; channelId: string; mode: string; isActive: boolean; options: SelfRoleOpt[] }

function SelfrolesSection({ base, guildId, canManage }: { base: string; guildId: string; canManage: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [showCreate, setShowCreate] = useState(false);
  const g = (p: string) => `${base}${p}${p.includes('?') ? '&' : '?'}guildId=${guildId}`;
  const q = useQuery({ queryKey: [base, 'selfroles', guildId], queryFn: () => api.get<{ items: SelfRoleMenuRow[] }>(g('/selfroles')), enabled: !!guildId });
  const inv = () => qc.invalidateQueries({ queryKey: [base, 'selfroles', guildId] });
  const create = useMutation({ mutationFn: (b: unknown) => api.post(g('/selfroles'), b), onSuccess: () => { toast.success('Menü erstellt.'); inv(); setShowCreate(false); }, onError: e => toast.error(errMsg(e)) });
  const addOpt = useMutation({ mutationFn: (vars: { id: string; b: unknown }) => api.post(g(`/selfroles/${vars.id}/options`), vars.b), onSuccess: () => { toast.success('Option hinzugefügt.'); inv(); }, onError: e => toast.error(errMsg(e)) });
  const delOpt = useMutation({ mutationFn: (vars: { id: string; optId: string }) => api.del(g(`/selfroles/${vars.id}/options/${vars.optId}`)), onSuccess: () => { inv(); }, onError: e => toast.error(errMsg(e)) });
  const post = useMutation({ mutationFn: (id: string) => api.post(g(`/selfroles/${id}/post`)), onSuccess: () => toast.success('Im Channel gepostet.'), onError: e => toast.error(errMsg(e)) });
  const toggle = useMutation({ mutationFn: (id: string) => api.post(g(`/selfroles/${id}/toggle`)), onSuccess: () => { inv(); }, onError: e => toast.error(errMsg(e)) });
  const del = useMutation({ mutationFn: (id: string) => api.del(g(`/selfroles/${id}`)), onSuccess: () => { toast.success('Gelöscht.'); inv(); }, onError: e => toast.error(errMsg(e)) });
  return (
    <Card glow>
      <SectionHeader title="Selfroles" desc="Self-Role-Menüs (früher /selfrole)" onRefresh={() => q.refetch()} loading={q.isFetching}
        action={canManage ? <Button size="sm" onClick={() => setShowCreate(s => !s)}>{showCreate ? 'Abbrechen' : 'Neues Menü'}</Button> : undefined} />
      <ReadOnlyHint canManage={canManage} />
      {showCreate && <SelfroleCreateForm onSubmit={b => create.mutate(b)} loading={create.isPending} />}
      {q.data && q.data.items.length === 0 && !showCreate && <EmptyState icon={Inbox} title="Keine Menüs" />}
      <div className="space-y-3">
        {q.data?.items.map(m => (
          <Card key={m.id} className="!p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-semibold text-white">{m.title}</span>
                  <Badge variant={m.isActive ? 'ok' : 'neutral'}>{m.isActive ? 'aktiv' : 'inaktiv'}</Badge>
                  <Badge variant="info">{m.mode}</Badge>
                </div>
                <p className="text-xs text-muted mt-0.5">Channel: {m.channelId} · {m.options.length} Optionen</p>
                <div className="flex flex-wrap gap-1 mt-2">
                  {m.options.map(o => (
                    <span key={o.id} className="inline-flex items-center gap-1 text-xs bg-bg-elev border border-border rounded px-2 py-0.5 text-muted">
                      {o.label}
                      {canManage && <button type="button" onClick={() => delOpt.mutate({ id: m.id, optId: o.id })} className="hover:text-danger"><X className="h-3 w-3" /></button>}
                    </span>
                  ))}
                </div>
              </div>
              {canManage && (
                <div className="flex flex-col gap-1 shrink-0">
                  <Button size="sm" variant="secondary" onClick={() => post.mutate(m.id)} loading={post.isPending}>Posten</Button>
                  <Button size="sm" variant="ghost" onClick={() => toggle.mutate(m.id)}>{m.isActive ? 'Deaktivieren' : 'Aktivieren'}</Button>
                  <Button size="sm" variant="danger" onClick={() => del.mutate(m.id)}><Trash2 className="h-4 w-4" /></Button>
                </div>
              )}
            </div>
            {canManage && <SelfroleOptionForm onSubmit={b => addOpt.mutate({ id: m.id, b })} loading={addOpt.isPending} />}
          </Card>
        ))}
      </div>
    </Card>
  );
}

function SelfroleCreateForm({ onSubmit, loading }: { onSubmit: (b: unknown) => void; loading: boolean }) {
  const [channelId, setChannelId] = useState('');
  const [title, setTitle] = useState('');
  const [mode, setMode] = useState('MULTI');
  return (
    <div className="p-3 mb-3 rounded-md bg-bg-elev border border-border space-y-2">
      <Input value={title} onChange={e => setTitle(e.target.value)} placeholder="Titel" />
      <Input value={channelId} onChange={e => setChannelId(e.target.value)} placeholder="Channel-ID" />
      <Select value={mode} onChange={e => setMode(e.target.value)}><option value="MULTI">Mehrfachauswahl</option><option value="SINGLE">Nur eine Rolle</option></Select>
      <Button size="sm" disabled={!title.trim() || !channelId.trim()} loading={loading} onClick={() => onSubmit({ title, channelId, mode })}>Erstellen</Button>
    </div>
  );
}

function SelfroleOptionForm({ onSubmit, loading }: { onSubmit: (b: unknown) => void; loading: boolean }) {
  const [roleId, setRoleId] = useState('');
  const [label, setLabel] = useState('');
  return (
    <div className="flex gap-2 mt-3 pt-3 border-t border-border">
      <Input value={label} onChange={e => setLabel(e.target.value)} placeholder="Label" className="!text-sm" />
      <Input value={roleId} onChange={e => setRoleId(e.target.value)} placeholder="Rollen-ID" className="!text-sm" />
      <Button size="sm" variant="secondary" disabled={!roleId.trim() || !label.trim()} loading={loading} onClick={() => { onSubmit({ roleId, label }); setRoleId(''); setLabel(''); }}>+</Button>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════
// FEEDS
// ════════════════════════════════════════════════════════════════════════
interface FeedRow { id: string; name: string; feedType: string; url: string; channelId: string; isActive: boolean; interval: number }

function FeedsSection({ base, guildId, canManage }: { base: string; guildId: string; canManage: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [showCreate, setShowCreate] = useState(false);
  const g = (p: string) => `${base}${p}${p.includes('?') ? '&' : '?'}guildId=${guildId}`;
  const q = useQuery({ queryKey: [base, 'feeds', guildId], queryFn: () => api.get<{ items: FeedRow[] }>(g('/feeds')), enabled: !!guildId });
  const inv = () => qc.invalidateQueries({ queryKey: [base, 'feeds', guildId] });
  const create = useMutation({ mutationFn: (b: unknown) => api.post(g('/feeds'), b), onSuccess: () => { toast.success('Feed erstellt.'); inv(); setShowCreate(false); }, onError: e => toast.error(errMsg(e)) });
  const toggle = useMutation({ mutationFn: (id: string) => api.post(g(`/feeds/${id}/toggle`)), onSuccess: () => inv(), onError: e => toast.error(errMsg(e)) });
  const del = useMutation({ mutationFn: (id: string) => api.del(g(`/feeds/${id}`)), onSuccess: () => { toast.success('Gelöscht.'); inv(); }, onError: e => toast.error(errMsg(e)) });
  return (
    <Card glow>
      <SectionHeader title="Feeds" desc="Feed-Quellen (früher /feed)" onRefresh={() => q.refetch()} loading={q.isFetching}
        action={canManage ? <Button size="sm" onClick={() => setShowCreate(s => !s)}>{showCreate ? 'Abbrechen' : 'Neuer Feed'}</Button> : undefined} />
      <ReadOnlyHint canManage={canManage} />
      {showCreate && <FeedCreateForm onSubmit={b => create.mutate(b)} loading={create.isPending} />}
      {q.data && q.data.items.length === 0 && !showCreate && <EmptyState icon={Inbox} title="Keine Feeds" />}
      <div className="space-y-2">
        {q.data?.items.map(f => (
          <Card key={f.id} className="!p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-semibold text-white truncate">{f.name}</span>
                  <Badge variant="info">{f.feedType}</Badge>
                  <Badge variant={f.isActive ? 'ok' : 'neutral'}>{f.isActive ? 'aktiv' : 'inaktiv'}</Badge>
                </div>
                <p className="text-xs text-muted mt-0.5 truncate">{f.url}</p>
                <p className="text-[11px] text-muted">Channel: {f.channelId} · alle {f.interval}s</p>
              </div>
              {canManage && (
                <div className="flex gap-1 shrink-0">
                  <Button size="sm" variant="ghost" onClick={() => toggle.mutate(f.id)}>{f.isActive ? 'Aus' : 'An'}</Button>
                  <Button size="sm" variant="danger" onClick={() => del.mutate(f.id)}><Trash2 className="h-4 w-4" /></Button>
                </div>
              )}
            </div>
          </Card>
        ))}
      </div>
    </Card>
  );
}

function FeedCreateForm({ onSubmit, loading }: { onSubmit: (b: unknown) => void; loading: boolean }) {
  const [name, setName] = useState('');
  const [feedType, setFeedType] = useState('RSS');
  const [url, setUrl] = useState('');
  const [channelId, setChannelId] = useState('');
  const [interval, setInterval] = useState('300');
  return (
    <div className="p-3 mb-3 rounded-md bg-bg-elev border border-border space-y-2">
      <Input value={name} onChange={e => setName(e.target.value)} placeholder="Name" />
      <Select value={feedType} onChange={e => setFeedType(e.target.value)}>{['RSS', 'TWITCH', 'TWITTER', 'STEAM', 'NEWS', 'WEBHOOK', 'CUSTOM'].map(t => <option key={t} value={t}>{t}</option>)}</Select>
      <Input value={url} onChange={e => setUrl(e.target.value)} placeholder="URL" />
      <Input value={channelId} onChange={e => setChannelId(e.target.value)} placeholder="Channel-ID" />
      <Input value={interval} onChange={e => setInterval(e.target.value)} placeholder="Intervall (Sek.)" type="number" />
      <Button size="sm" disabled={!name.trim() || !url.trim() || !channelId.trim()} loading={loading} onClick={() => onSubmit({ name, feedType, url, channelId, interval: Number(interval) })}>Erstellen</Button>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════
// ÜBERSETZUNGEN
// ════════════════════════════════════════════════════════════════════════
interface TranslateRow { id: string; targetLang: string; channelId: string; customTitle: string | null; translatedText: string | null; createdAt: string }

function TranslateSection({ base, guildId, canManage }: { base: string; guildId: string; canManage: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [showCreate, setShowCreate] = useState(false);
  const g = (p: string) => `${base}${p}${p.includes('?') ? '&' : '?'}guildId=${guildId}`;
  const q = useQuery({ queryKey: [base, 'translate', guildId], queryFn: () => api.get<{ items: TranslateRow[]; languages: string[] }>(g('/translate')), enabled: !!guildId });
  const inv = () => qc.invalidateQueries({ queryKey: [base, 'translate', guildId] });
  const create = useMutation({ mutationFn: (b: unknown) => api.post(g('/translate'), b), onSuccess: () => { toast.success('Übersetzt & gespeichert.'); inv(); setShowCreate(false); }, onError: e => toast.error(errMsg(e)) });
  const del = useMutation({ mutationFn: (id: string) => api.del(g(`/translate/${id}`)), onSuccess: () => { toast.success('Gelöscht.'); inv(); }, onError: e => toast.error(errMsg(e)) });
  return (
    <Card glow>
      <SectionHeader title="Übersetzungen" desc="Posts übersetzen (früher /translate-post)" onRefresh={() => q.refetch()} loading={q.isFetching}
        action={canManage ? <Button size="sm" onClick={() => setShowCreate(s => !s)}>{showCreate ? 'Abbrechen' : 'Neu'}</Button> : undefined} />
      <ReadOnlyHint canManage={canManage} />
      {showCreate && q.data && <TranslateCreateForm languages={q.data.languages} onSubmit={b => create.mutate(b)} loading={create.isPending} />}
      {q.data && q.data.items.length === 0 && !showCreate && <EmptyState icon={Inbox} title="Keine Übersetzungen" />}
      <div className="space-y-2">
        {q.data?.items.map(t => (
          <Card key={t.id} className="!p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2"><Badge variant="info">{t.targetLang.toUpperCase()}</Badge><span className="font-semibold text-white truncate">{t.customTitle ?? 'Übersetzung'}</span></div>
                <p className="text-sm text-muted mt-1 line-clamp-2">{t.translatedText}</p>
              </div>
              {canManage && <Button size="sm" variant="danger" onClick={() => del.mutate(t.id)}><Trash2 className="h-4 w-4" /></Button>}
            </div>
          </Card>
        ))}
      </div>
    </Card>
  );
}

function TranslateCreateForm({ languages, onSubmit, loading }: { languages: string[]; onSubmit: (b: unknown) => void; loading: boolean }) {
  const [sourceText, setSourceText] = useState('');
  const [targetLang, setTargetLang] = useState(languages[0] ?? 'en');
  const [channelId, setChannelId] = useState('');
  const [customTitle, setCustomTitle] = useState('');
  return (
    <div className="p-3 mb-3 rounded-md bg-bg-elev border border-border space-y-2">
      <textarea value={sourceText} onChange={e => setSourceText(e.target.value)} maxLength={4000} placeholder="Quelltext" className="w-full rounded-md bg-bg border border-border px-3 py-2 text-sm text-white" rows={4} />
      <Input value={customTitle} onChange={e => setCustomTitle(e.target.value)} placeholder="Titel (optional)" />
      <div className="flex gap-2">
        <Select value={targetLang} onChange={e => setTargetLang(e.target.value)}>{languages.map(l => <option key={l} value={l}>{l.toUpperCase()}</option>)}</Select>
        <Input value={channelId} onChange={e => setChannelId(e.target.value)} placeholder="Channel-ID" />
      </div>
      <Button size="sm" disabled={!sourceText.trim() || !channelId.trim()} loading={loading} onClick={() => onSubmit({ sourceText, targetLang, channelId, customTitle: customTitle || undefined })}>Übersetzen</Button>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════
// XP-SYSTEM
// ════════════════════════════════════════════════════════════════════════
interface XpConfig { id: string; messageXpMin: number; messageXpMax: number; voiceXpPerMinute: number; eventXpBonus: number; xpCooldownSeconds: number; levelMultiplier: number; maxLevel: number; isActive: boolean }
interface LevelRoleRow { id: string; level: number; roleId: string }

function XpSection({ base, guildId, canManage }: { base: string; guildId: string; canManage: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const g = (p: string) => `${base}${p}${p.includes('?') ? '&' : '?'}guildId=${guildId}`;
  const q = useQuery({ queryKey: [base, 'xp', guildId], queryFn: () => api.get<{ config: XpConfig; levelRoles: LevelRoleRow[] }>(g('/xp')), enabled: !!guildId });
  const inv = () => qc.invalidateQueries({ queryKey: [base, 'xp', guildId] });
  const patch = useMutation({ mutationFn: (b: Partial<XpConfig>) => api.patch(`${base}/xp`, b), onSuccess: () => { toast.success('XP-Konfiguration gespeichert.'); inv(); }, onError: e => toast.error(errMsg(e)) });
  const addRole = useMutation({ mutationFn: (b: unknown) => api.post(g('/xp/level-roles'), b), onSuccess: () => { toast.success('Level-Rolle hinzugefügt.'); inv(); }, onError: e => toast.error(errMsg(e)) });
  const delRole = useMutation({ mutationFn: (id: string) => api.del(g(`/xp/level-roles/${id}`)), onSuccess: () => inv(), onError: e => toast.error(errMsg(e)) });
  const [draft, setDraft] = useState<Partial<XpConfig> | null>(null);
  const cfg = { ...(q.data?.config as XpConfig | undefined), ...draft } as XpConfig | undefined;
  const num = (k: keyof XpConfig, label: string) => (
    <label className="block">
      <span className="text-xs text-muted">{label}</span>
      <Input type="number" value={cfg ? String(cfg[k]) : ''} disabled={!canManage} onChange={e => setDraft(d => ({ ...d, [k]: Number(e.target.value) }))} />
    </label>
  );
  return (
    <Card glow>
      <SectionHeader title="XP-System" desc="Level & Raten (früher /xp-config)" onRefresh={() => q.refetch()} loading={q.isFetching} />
      <ReadOnlyHint canManage={canManage} />
      {cfg && (
        <div className="space-y-4 max-w-2xl">
          <div className="grid gap-3 sm:grid-cols-3">
            {num('messageXpMin', 'Nachricht XP min')}
            {num('messageXpMax', 'Nachricht XP max')}
            {num('voiceXpPerMinute', 'Voice XP/min')}
            {num('eventXpBonus', 'Event-Bonus')}
            {num('xpCooldownSeconds', 'Cooldown (Sek.)')}
            {num('maxLevel', 'Max-Level')}
          </div>
          {canManage && <Button size="sm" disabled={!draft} loading={patch.isPending} onClick={() => { if (draft) patch.mutate(draft); setDraft(null); }}>Speichern</Button>}
          <div>
            <h3 className="text-sm font-semibold text-white mb-2">Level-Rollen</h3>
            <div className="space-y-1 mb-2">
              {q.data?.levelRoles.map(lr => (
                <div key={lr.id} className="flex items-center justify-between p-2 rounded bg-bg-elev border border-border text-sm">
                  <span className="text-muted">Level {lr.level} → <span className="font-mono">{lr.roleId}</span></span>
                  {canManage && <button type="button" onClick={() => delRole.mutate(lr.id)} className="text-muted hover:text-danger"><Trash2 className="h-4 w-4" /></button>}
                </div>
              ))}
            </div>
            {canManage && <LevelRoleForm onSubmit={b => addRole.mutate(b)} loading={addRole.isPending} />}
          </div>
        </div>
      )}
    </Card>
  );
}

function LevelRoleForm({ onSubmit, loading }: { onSubmit: (b: unknown) => void; loading: boolean }) {
  const [level, setLevel] = useState('');
  const [roleId, setRoleId] = useState('');
  return (
    <div className="flex gap-2">
      <Input type="number" value={level} onChange={e => setLevel(e.target.value)} placeholder="Level" className="!w-24" />
      <Input value={roleId} onChange={e => setRoleId(e.target.value)} placeholder="Rollen-ID" />
      <Button size="sm" variant="secondary" disabled={!level || !roleId.trim()} loading={loading} onClick={() => { onSubmit({ level: Number(level), roleId }); setLevel(''); setRoleId(''); }}>+</Button>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════
// GEFAHRENZONE
// ════════════════════════════════════════════════════════════════════════
function DangerSection({ base, canDanger }: { base: string; canDanger: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  const q = useQuery({ queryKey: [base, 'danger'], queryFn: () => api.get<{ softDeletedPackages: number; suspendedUsers: number; recentDangerActions: Array<{ id: string; action: string; createdAt: string }> }>(`${base}/danger`) });
  const purge = useMutation({
    mutationFn: () => api.post(`${base}/danger/purge-deleted-packages`, { confirm: 'DELETE' }),
    onSuccess: () => { toast.success('Gelöschte Pakete endgültig entfernt.'); setConfirm(false); qc.invalidateQueries({ queryKey: [base, 'danger'] }); }, onError: e => { toast.error(errMsg(e)); setConfirm(false); },
  });
  return (
    <Card glow className="border-danger/30">
      <SectionHeader title="Gefahrenzone" desc="Gefährliche, nicht umkehrbare Aktionen" onRefresh={() => q.refetch()} loading={q.isFetching} />
      {!canDanger && (
        <p className="text-sm text-warn inline-flex items-center gap-1 mb-3"><AlertTriangle className="h-4 w-4" /> Diese Aktionen erfordern eine aktive Bot-Admin-Session.</p>
      )}
      {q.data && (
        <div className="grid gap-3 sm:grid-cols-2 mb-5">
          <Card className="!p-4"><p className="text-xs text-muted">Soft-gelöschte Pakete</p><p className="text-2xl font-bold text-white mt-1">{q.data.softDeletedPackages}</p></Card>
          <Card className="!p-4"><p className="text-xs text-muted">Gesperrte Nutzer</p><p className="text-2xl font-bold text-white mt-1">{q.data.suspendedUsers}</p></Card>
        </div>
      )}
      <Card className="!p-4 border-danger/30">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="font-medium text-danger">Gelöschte Pakete endgültig entfernen</p>
            <p className="text-xs text-muted mt-0.5">Entfernt alle soft-gelöschten Pakete unwiderruflich aus der Datenbank.</p>
          </div>
          <Button size="sm" variant="danger" disabled={!canDanger || (q.data?.softDeletedPackages ?? 0) === 0} onClick={() => setConfirm(true)}>Endgültig löschen</Button>
        </div>
      </Card>
      {q.data && q.data.recentDangerActions.length > 0 && (
        <div className="mt-5">
          <h3 className="text-sm font-semibold text-white mb-2">Letzte gefährliche Aktionen</h3>
          <ul className="space-y-1">
            {q.data.recentDangerActions.map(a => <li key={a.id} className="text-xs text-muted">{a.action.replace('BOTADMIN_', '')} · {new Date(a.createdAt).toLocaleString('de-DE')}</li>)}
          </ul>
        </div>
      )}
      <ConfirmDialog open={confirm} title="Pakete endgültig löschen" desc="Diese Aktion ist nicht umkehrbar." confirmLabel="Endgültig löschen" danger requireType="DELETE"
        onConfirm={() => purge.mutate()} onClose={() => setConfirm(false)} loading={purge.isPending} />
    </Card>
  );
}
