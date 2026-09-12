/**
 * Bot-Admin-Bereich — globale, passwortgeschuetzte Seite (analog DEV).
 *
 * Zwei Gates (defense in depth):
 *   1. useBotAdminSession().active — Frontend gegen /api/v2/bot-admin/status
 *   2. requireBotAdmin (Backend)   — alle /api/v2/bot-admin/* Routen blocken sonst
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BookOpen, Lock, LayoutDashboard, TerminalSquare } from 'lucide-react';
import { Shell } from '@/components/Shell';
import { Card, CardHeader, CardTitle, CardDesc } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { BotAdminTab } from '@/components/BotAdminTab';
import { BotAdminCommandCenter } from '@/components/BotAdminCommandCenter';
import { BotAdminKnowledgeScoped } from '@/components/BotAdminKnowledgeScoped';
import { useAuth } from '@/lib/auth';
import { api, ApiError } from '@/lib/api';
import { useBotAdminSession } from '@/lib/botAdminSession';

interface DevEligibilityStatus {
  active: boolean;
  eligible: boolean;
  expiresAt?: string | null;
}

export default function BotAdminPage() {
  const { user } = useAuth();
  const ba = useBotAdminSession();
  const [view, setView] = useState<'admin' | 'knowledge' | 'commands'>('admin');
  const feedbackEligibility = useQuery({
    queryKey: ['bot-admin', 'feedback-developer-eligibility', user?.discordId ?? 'anonymous'],
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
  const showFeedback = feedbackEligibility.data === true;

  if (!user) {
    return <Shell title="Bot-Admin" back="/servers"><Card glow className="max-w-md mx-auto"><CardHeader><CardTitle><Lock className="h-4 w-4 inline mr-1" /> Kein Zugriff</CardTitle><CardDesc>Bitte melde dich an.</CardDesc></CardHeader></Card></Shell>;
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
      <div className="max-w-content mx-auto space-y-4">
        <div className="flex flex-wrap gap-2" role="navigation" aria-label="Bot-Admin Hauptbereiche">
          <Button size="sm" variant={view === 'admin' ? 'primary' : 'ghost'} onClick={() => setView('admin')}><LayoutDashboard className="h-4 w-4" />Verwaltung</Button>
          <Button size="sm" variant={view === 'knowledge' ? 'primary' : 'ghost'} onClick={() => setView('knowledge')}><BookOpen className="h-4 w-4" />AI-Wissensbank</Button>
          <Button size="sm" variant={view === 'commands' ? 'primary' : 'ghost'} onClick={() => setView('commands')}><TerminalSquare className="h-4 w-4" />Migrierte Bot-Commands</Button>
        </div>
        {view === 'admin' && <BotAdminTab showFeedback={showFeedback} />}
        {view === 'knowledge' && <BotAdminKnowledgeScoped />}
        {view === 'commands' && <BotAdminCommandCenter showFeedback={showFeedback} />}
      </div>
    </Shell>
  );
}
