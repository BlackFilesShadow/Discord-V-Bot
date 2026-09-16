/**
 * Bot-Admin-Bereich — globale, passwortgeschuetzte Seite (analog DEV).
 *
 * Zwei Gates (defense in depth):
 *   1. useBotAdminSession().active — Frontend gegen /api/v2/bot-admin/status
 *   2. requireBotAdmin (Backend)   — alle /api/v2/bot-admin/* Routen blocken sonst
 *
 * Die eigentliche Workspace-Oberflaeche ist bewusst wiederverwendbar: Der
 * kanonische DEV/Owner kann dieselben Funktionen direkt innerhalb von /dev
 * nutzen. Die Backend-Autorisierung bleibt unveraendert bei requireBotAdmin,
 * dessen DEV-Fallback eine gueltige DEV-Session akzeptiert.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BookOpen, Inbox, Lock, LayoutDashboard, TerminalSquare } from 'lucide-react';
import { Shell } from '@/components/Shell';
import { Card, CardHeader, CardTitle, CardDesc } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { BotAdminTab } from '@/components/BotAdminTab';
import { BotAdminCommandCenter } from '@/components/BotAdminCommandCenter';
import { BotAdminKnowledgeScoped } from '@/components/BotAdminKnowledgeScoped';
import { BotAdminOwnerTickets } from '@/components/BotAdminOwnerTickets';
import { useAuth } from '@/lib/auth';
import { api, ApiError } from '@/lib/api';
import { useBotAdminSession } from '@/lib/botAdminSession';

interface DevEligibilityStatus {
  active: boolean;
  eligible: boolean;
  expiresAt?: string | null;
}

interface BotAdminWorkspaceProps {
  isDeveloperOwner: boolean;
}

/**
 * Gemeinsame Bot-Admin-Oberflaeche fuer die eigenstaendige /bot-admin-Seite
 * und die DEV-Konsole. Sie besitzt absichtlich keinen eigenen Auth-Gate; der
 * jeweilige Parent stellt die gueltige Step-up-Session sicher und das Backend
 * erzwingt requireBotAdmin auf den API-Routen.
 */
export function BotAdminWorkspace({ isDeveloperOwner }: BotAdminWorkspaceProps) {
  const [view, setView] = useState<'admin' | 'tickets' | 'knowledge' | 'commands'>('admin');

  return (
    <div className="max-w-content mx-auto space-y-4">
      <div className="flex flex-wrap gap-2" role="navigation" aria-label="Bot-Admin Hauptbereiche">
        <Button size="sm" variant={view === 'admin' ? 'primary' : 'ghost'} onClick={() => setView('admin')}><LayoutDashboard className="h-4 w-4" />Verwaltung</Button>
        {isDeveloperOwner && <Button size="sm" variant={view === 'tickets' ? 'primary' : 'ghost'} onClick={() => setView('tickets')}><Inbox className="h-4 w-4" />Owner-Tickets</Button>}
        <Button size="sm" variant={view === 'knowledge' ? 'primary' : 'ghost'} onClick={() => setView('knowledge')}><BookOpen className="h-4 w-4" />AI-Wissensbank</Button>
        <Button size="sm" variant={view === 'commands' ? 'primary' : 'ghost'} onClick={() => setView('commands')}><TerminalSquare className="h-4 w-4" />Migrierte Bot-Commands</Button>
      </div>
      {view === 'admin' && <BotAdminTab showFeedback={isDeveloperOwner} />}
      {isDeveloperOwner && view === 'tickets' && <BotAdminOwnerTickets />}
      {view === 'knowledge' && <BotAdminKnowledgeScoped />}
      {view === 'commands' && <BotAdminCommandCenter showFeedback={isDeveloperOwner} />}
    </div>
  );
}

/** DEV-Unterseite: der Parent /dev hat DEV-Identitaet + aktive DEV-Session bereits geprueft. */
export function DevBotAdminPage() {
  return <BotAdminWorkspace isDeveloperOwner />;
}

export default function BotAdminPage() {
  const { user } = useAuth();
  const ba = useBotAdminSession();
  const developerEligibility = useQuery({
    queryKey: ['bot-admin', 'developer-owner-eligibility', user?.discordId ?? 'anonymous'],
    enabled: Boolean(user && ba.active),
    retry: false,
    staleTime: 30_000,
    queryFn: async (): Promise<boolean> => {
      try {
        const status = await api.get<DevEligibilityStatus>('/api/v2/dev/status');
        return status.eligible === true;
      } catch (error) {
        if (error instanceof ApiError && (error.status === 401 || error.status === 403)) return false;
        throw error;
      }
    },
  });
  const isDeveloperOwner = developerEligibility.data === true;

  if (!user) {
    return <Shell title="Bot-Admin" back="/servers"><Card glow className="max-w-md mx-auto"><CardHeader><CardTitle><Lock className="h-4 w-4 inline mr-1" /> Kein Zugriff</CardTitle><CardDesc>Bitte melde dich an.</CardDesc></CardHeader></Card></Shell>;
  }

  // Bevor die serverseitige /bot-admin/status-Wahrheit feststeht, darf kein
  // privilegiertes Bot-Admin-Tool gerendert werden - sonst kann ein alter
  // sessionStorage-Hint (z.B. nach serverseitigem Session-Ablauf ohne
  // explizites Logout) die volle Workspace kurz aufblitzen lassen, bevor die
  // Statusabfrage zurueckkommt. Analog zu Dev.tsx's dev.loading-Gate.
  if (ba.loading) {
    return (
      <Shell title="Bot-Admin" back="/servers">
        <Card glow className="max-w-md mx-auto"><CardHeader><CardTitle><Lock className="h-4 w-4 inline mr-1" /> Bot-Admin-Status wird geprueft</CardTitle><CardDesc>Die serverseitige Bot-Admin-Session wird bestaetigt.</CardDesc></CardHeader></Card>
      </Shell>
    );
  }

  if (!ba.active) {
    return (
      <Shell title="Bot-Admin" back="/servers">
        <Card glow className="max-w-md mx-auto">
          <CardHeader><CardTitle><Lock className="h-4 w-4 inline mr-1" /> Bot-Admin-Session erforderlich</CardTitle><CardDesc>Bitte melde dich oben links ueber das Bot-Admin Login Panel an. Direkter URL-Zugriff ohne aktive Session ist serverseitig blockiert.</CardDesc></CardHeader>
          <a href="/servers" className="inline-block"><Button size="sm">Zur Server-Uebersicht</Button></a>
        </Card>
      </Shell>
    );
  }

  return (
    <Shell title="Bot-Admin" back="/servers">
      <BotAdminWorkspace isDeveloperOwner={isDeveloperOwner} />
    </Shell>
  );
}
