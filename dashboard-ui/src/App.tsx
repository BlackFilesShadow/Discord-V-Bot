import { lazy, Suspense, type ComponentType } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './lib/auth';
import Login from './pages/Login';
import Servers from './pages/Servers';
import Server from './pages/Server';
import ServerSlot from './pages/ServerSlot';
import Dev, { DEV_TOOLS } from './pages/Dev';
import BotAdmin from './pages/BotAdmin';
import { Toaster } from './components/ui/Toast';

function Protected({ children }: { children: JSX.Element }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="grid place-items-center h-full text-muted">Lade…</div>;
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

function LazyFallback() {
  return <div className="grid place-items-center h-full text-muted p-6">Lade Modul…</div>;
}

function lazyPage(loader: () => Promise<{ default: ComponentType }>) {
  const Comp = lazy(loader);
  return function LazyRoute() {
    return (
      <Suspense fallback={<LazyFallback />}>
        <Comp />
      </Suspense>
    );
  };
}

// Stage 56: code-split DEV tools so the main shell does not eagerly pull every diagnostic page.
const DEV_PAGES: Record<string, ComponentType> = {
  'bot-status': lazyPage(() => import('./pages/dev/LiveBotStatus')),
  'dashboard-status': lazyPage(() => import('./pages/dev/DashboardStatus')),
  'database-status': lazyPage(() => import('./pages/dev/DatabaseStatus')),
  'nitrado-status': lazyPage(() => import('./pages/dev/NitradoStatus')),
  'nitrado-protection': lazyPage(() => import('./pages/dev/NitradoProtection')),
  'member-detection': lazyPage(() => import('./pages/dev/MemberDetection')),
  'discord-status': lazyPage(() => import('./pages/dev/DiscordStatus')),
  'system-health': lazyPage(() => import('./pages/dev/SystemHealth')),
  'error-monitoring': lazyPage(() => import('./pages/dev/ErrorMonitoring')),
  'live-sync': lazyPage(() => import('./pages/dev/LiveSyncStatus')),
  'backup-status': lazyPage(() => import('./pages/dev/BackupStatus')),
  'security-status': lazyPage(() => import('./pages/dev/SecurityStatus')),
  'active-sessions': lazyPage(() => import('./pages/dev/ActiveSessions')),
  'incident-response': lazyPage(() => import('./pages/dev/IncidentResponse')),
  'observability': lazyPage(() => import('./pages/dev/Observability')),
  'adm-analysis': lazyPage(() => import('./pages/dev/AdmAnalysis')),
  'rpt-analysis': lazyPage(() => import('./pages/dev/RptAnalysis')),
  'xml-validator': lazyPage(() => import('./pages/dev/XmlValidator')),
  'json-validator': lazyPage(() => import('./pages/dev/JsonValidator')),
  'debug-tools': lazyPage(() => import('./pages/dev/DebugTools')),
  'audit-logs': lazyPage(() => import('./pages/dev/AuditLogs')),
  'command-diag': lazyPage(() => import('./pages/dev/CommandDiagnostics')),
  'killfeed': lazyPage(() => import('./pages/dev/Killfeed')),
  'player-tracking': lazyPage(() => import('./pages/dev/PlayerTracking')),
  'raid-analysis': lazyPage(() => import('./pages/dev/RaidAnalysis')),
  'base-proximity': lazyPage(() => import('./pages/dev/BaseProximity')),
  'movement-heatmap': lazyPage(() => import('./pages/dev/MovementHeatmap')),
  'suspicious': lazyPage(() => import('./pages/dev/SuspiciousActivity')),
  'faction-activity': lazyPage(() => import('./pages/dev/FactionActivity')),
  'vehicle-tracking': lazyPage(() => import('./pages/dev/VehicleTracking')),
  'ai-providers': lazyPage(() => import('./pages/dev/AiProviderStats')),
  'ai-context-debugger': lazyPage(() => import('./pages/dev/AiContextDebugger')),
  'nitrado-mirror': lazyPage(() => import('./pages/dev/NitradoMirror')),
};

const CommandCenter = lazyPage(() => import('./pages/dev/CommandCenter'));
const SecureDevExport = lazyPage(() => import('./pages/dev/SecureDevExport'));

const _missing = DEV_TOOLS.filter(t => !DEV_PAGES[t.slug]).map(t => t.slug);
if (_missing.length > 0) {
  // eslint-disable-next-line no-console
  console.error('[DEV] DEV_TOOLS ohne Page-Mapping:', _missing);
}

export default function App() {
  return (
    <Toaster>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/servers" element={<Protected><Servers /></Protected>} />
        <Route path="/servers/:guildId" element={<Protected><Server /></Protected>} />
        <Route path="/servers/:guildId/server/:slot" element={<Protected><ServerSlot /></Protected>} />
        <Route path="/bot-admin" element={<Protected><BotAdmin /></Protected>} />
        <Route path="/dev" element={<Protected><Dev /></Protected>}>
          <Route index element={<Navigate to="bot-status" replace />} />
          <Route path="command-center" element={<CommandCenter />} />
          <Route path="secure-export" element={<SecureDevExport />} />
          {DEV_TOOLS.map(t => {
            const Page = DEV_PAGES[t.slug];
            if (!Page) return null;
            return <Route key={t.slug} path={t.slug} element={<Page />} />;
          })}
          <Route path="*" element={<Navigate to="bot-status" replace />} />
        </Route>
        <Route path="*" element={<Navigate to="/servers" replace />} />
      </Routes>
    </Toaster>
  );
}
