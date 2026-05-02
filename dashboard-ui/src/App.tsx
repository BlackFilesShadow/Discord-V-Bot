import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './lib/auth';
import Login from './pages/Login';
import Servers from './pages/Servers';
import Server from './pages/Server';
import ServerSlot from './pages/ServerSlot';
import Dev, { DEV_TOOLS } from './pages/Dev';
import LiveBotStatus from './pages/dev/LiveBotStatus';
import DashboardStatus from './pages/dev/DashboardStatus';
import DatabaseStatus from './pages/dev/DatabaseStatus';
import NitradoStatus from './pages/dev/NitradoStatus';
import DiscordStatus from './pages/dev/DiscordStatus';
import SystemHealth from './pages/dev/SystemHealth';
import ErrorMonitoring from './pages/dev/ErrorMonitoring';
import LiveSyncStatus from './pages/dev/LiveSyncStatus';
import BackupStatus from './pages/dev/BackupStatus';
import SecurityStatus from './pages/dev/SecurityStatus';
import AdmAnalysis from './pages/dev/AdmAnalysis';
import RptAnalysis from './pages/dev/RptAnalysis';
import XmlValidator from './pages/dev/XmlValidator';
import JsonValidator from './pages/dev/JsonValidator';
import DebugTools from './pages/dev/DebugTools';
import AuditLogs from './pages/dev/AuditLogs';
import CommandDiagnostics from './pages/dev/CommandDiagnostics';
import Killfeed from './pages/dev/Killfeed';
import PlayerTracking from './pages/dev/PlayerTracking';
import RaidAnalysisTool from './pages/dev/RaidAnalysis';
import BaseProximity from './pages/dev/BaseProximity';
import MovementHeatmap from './pages/dev/MovementHeatmap';
import SuspiciousActivity from './pages/dev/SuspiciousActivity';
import FactionActivity from './pages/dev/FactionActivity';
import VehicleTracking from './pages/dev/VehicleTracking';
import AiProviderStats from './pages/dev/AiProviderStats';
import { DevLoginPanel } from './components/DevLoginPanel';

function Protected({ children }: { children: JSX.Element }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="grid place-items-center h-full text-muted">Lade…</div>;
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

// Slug -> Component Mapping. Reihenfolge muss zu DEV_TOOLS in pages/Dev.tsx passen.
const DEV_PAGES: Record<string, () => JSX.Element> = {
  'bot-status': LiveBotStatus,
  'dashboard-status': DashboardStatus,
  'database-status': DatabaseStatus,
  'nitrado-status': NitradoStatus,
  'discord-status': DiscordStatus,
  'system-health': SystemHealth,
  'error-monitoring': ErrorMonitoring,
  'live-sync': LiveSyncStatus,
  'backup-status': BackupStatus,
  'security-status': SecurityStatus,
  'adm-analysis': AdmAnalysis,
  'rpt-analysis': RptAnalysis,
  'xml-validator': XmlValidator,
  'json-validator': JsonValidator,
  'debug-tools': DebugTools,
  'audit-logs': AuditLogs,
  'command-diag': CommandDiagnostics,
  'killfeed': Killfeed,
  'player-tracking': PlayerTracking,
  'raid-analysis': RaidAnalysisTool,
  'base-proximity': BaseProximity,
  'movement-heatmap': MovementHeatmap,
  'suspicious': SuspiciousActivity,
  'faction-activity': FactionActivity,
  'vehicle-tracking': VehicleTracking,
  'ai-providers': AiProviderStats,
};

// Registry-Konsistenz-Check (Compile-Zeit-Hilfe; failt frueh wenn Tools/Pages
// auseinanderlaufen).
const _missing = DEV_TOOLS.filter(t => !DEV_PAGES[t.slug]).map(t => t.slug);
if (_missing.length > 0) {
  // eslint-disable-next-line no-console
  console.error('[DEV] DEV_TOOLS ohne Page-Mapping:', _missing);
}

export default function App() {
  return (
    <>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/servers" element={<Protected><Servers /></Protected>} />
        <Route path="/servers/:guildId" element={<Protected><Server /></Protected>} />
        <Route path="/servers/:guildId/server/:slot" element={<Protected><ServerSlot /></Protected>} />
        <Route path="/dev" element={<Protected><Dev /></Protected>}>
          <Route index element={<Navigate to="bot-status" replace />} />
          {DEV_TOOLS.map(t => {
            const Page = DEV_PAGES[t.slug];
            if (!Page) return null;
            return <Route key={t.slug} path={t.slug} element={<Page />} />;
          })}
          <Route path="*" element={<Navigate to="bot-status" replace />} />
        </Route>
        <Route path="*" element={<Navigate to="/servers" replace />} />
      </Routes>
      {/* Global gemountet: rendert sich selbst nur fuer DEVELOPER (Spec 1+5). */}
      <DevLoginPanel />
    </>
  );
}
