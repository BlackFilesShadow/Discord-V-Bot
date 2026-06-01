/**
 * Bot-Admin-Bereich — globale, passwortgeschuetzte Seite (analog DEV).
 *
 * Zwei Gates (defense in depth):
 *   1. useBotAdminSession().active — Frontend gegen /api/v2/bot-admin/status
 *   2. requireBotAdmin (Backend)   — alle /api/v2/bot-admin/* Routen blocken sonst
 *
 * Anmeldung erfolgt ueber das Bot-Admin-Login-Panel in der Topbar
 * (Passwort = BOT_ADMIN_PASSWORD, Default "ASH").
 */
import { Lock } from 'lucide-react';
import { Shell } from '@/components/Shell';
import { Card, CardHeader, CardTitle, CardDesc } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { BotAdminTab } from '@/components/BotAdminTab';
import { useAuth } from '@/lib/auth';
import { useBotAdminSession } from '@/lib/botAdminSession';

export default function BotAdminPage() {
  const { user } = useAuth();
  const ba = useBotAdminSession();

  if (!user) {
    return (
      <Shell title="Bot-Admin" back="/servers">
        <Card glow className="max-w-md mx-auto">
          <CardHeader>
            <CardTitle><Lock className="h-4 w-4 inline mr-1" /> Kein Zugriff</CardTitle>
            <CardDesc>Bitte melde dich an.</CardDesc>
          </CardHeader>
        </Card>
      </Shell>
    );
  }

  if (!ba.active) {
    return (
      <Shell title="Bot-Admin" back="/servers">
        <Card glow className="max-w-md mx-auto">
          <CardHeader>
            <CardTitle><Lock className="h-4 w-4 inline mr-1" /> Bot-Admin-Session erforderlich</CardTitle>
            <CardDesc>
              Bitte melde dich oben links ueber das Bot-Admin Login Panel an.
              Direkter URL-Zugriff ohne aktive Session ist serverseitig blockiert.
            </CardDesc>
          </CardHeader>
          <a href="/servers" className="inline-block">
            <Button size="sm">Zur Server-Uebersicht</Button>
          </a>
        </Card>
      </Shell>
    );
  }

  return (
    <Shell title="Bot-Admin" back="/servers">
      <div className="max-w-content mx-auto">
        <BotAdminTab />
      </div>
    </Shell>
  );
}
