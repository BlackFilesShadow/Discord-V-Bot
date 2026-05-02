/**
 * EnterpriseStub — konsistente Layout-Vorlage fuer noch nicht
 * vollstaendig implementierte DEV-Tools.
 *
 * Wichtig (Spec 11): KEINE Fake-Metriken, KEINE simulierten Daten.
 * Wir zeigen nur:
 *   - Status-Badge "In Entwicklung"
 *   - Geplante Pflicht-Funktionen (Liste)
 *   - Geplante Datenquellen (DB-Tabellen / Endpoints / Files)
 *   - Phase-Hinweis
 *   - Optional: Roadmap-Link / "Diesen Stub anpinnen"
 *
 * Loest den alten _ToolStub.tsx ab (bleibt aber kompatibel: gleicher
 * Default-Export-Wrapper an einzelnen Stub-Pages).
 */
import { Construction, Database, Cog, ListChecks } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardDesc } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { Button } from '@/components/ui/Button';
import { usePinnedTools } from '@/lib/pinnedTools';

export interface EnterpriseStubProps {
  /** Slug — fuer Pin-Toggle / Routing-Konsistenz. */
  slug: string;
  title: string;
  desc: string;
  /** Zugehoerige Phase (P0 .. P4). */
  phase: 'P0' | 'P1' | 'P2' | 'P3' | 'P4';
  /** Pflichtfunktionen, die in der Phase realisiert werden. */
  features: ReadonlyArray<string>;
  /** Geplante Datenquellen / Endpoints (Tabellen, /api/v2/dev/*, Files). */
  dataSources?: ReadonlyArray<string>;
  /** Optional: was bereits aktiv ist (Auth/Routing/Sidebar etc.). */
  alreadyActive?: ReadonlyArray<string>;
}

const PHASE_DESC: Record<EnterpriseStubProps['phase'], string> = {
  P0: 'CRITICAL Compliance (SOC2 CC6.1 / ISO A.9.1.1)',
  P1: 'Session-Lifecycle & Cleanup (SOC2 CC7.1)',
  P2: 'Incident-Response-Console',
  P3: 'Observability-Layer (SOC2 CC5.2)',
  P4: 'Stub-Pages ausimplementiert + UX-Polish',
};

export function EnterpriseStub({
  slug, title, desc, phase, features, dataSources, alreadyActive,
}: EnterpriseStubProps) {
  const { isPinned, toggle } = usePinnedTools();
  const pinned = isPinned(slug);

  return (
    <div className="space-y-6">
      <SectionHeader
        eyebrow={`${phase} · ${PHASE_DESC[phase]}`}
        icon={<Construction className="h-5 w-5 text-warn" />}
        title={title}
        desc={desc}
        actions={
          <>
            <Badge variant="warn" pulse>In Entwicklung</Badge>
            <Button
              variant={pinned ? 'secondary' : 'outline'}
              size="sm"
              onClick={() => toggle(slug)}
              title={pinned ? 'Entpinnen' : 'Pinnen'}
            >
              {pinned ? 'Gepinnt' : 'Pinnen'}
            </Button>
          </>
        }
      />

      <Card glow>
        <CardHeader>
          <CardTitle><ListChecks className="h-4 w-4 inline mr-1.5 text-info" /> Geplante Pflichtfunktionen</CardTitle>
          <CardDesc>Quelle: Enterprise-Plan (Phase {phase}). Wird ohne Fake-Daten ausgeliefert.</CardDesc>
        </CardHeader>
        <ul className="grid sm:grid-cols-2 gap-1.5 text-xs text-white/80">
          {features.map(f => (
            <li key={f} className="flex items-start gap-2">
              <span className="text-accent mt-0.5">•</span>
              <span>{f}</span>
            </li>
          ))}
        </ul>
      </Card>

      {dataSources && dataSources.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle><Database className="h-4 w-4 inline mr-1.5 text-info" /> Datenquellen</CardTitle>
            <CardDesc>Tabellen / Endpoints / Files, aus denen das Tool sich speist.</CardDesc>
          </CardHeader>
          <ul className="grid sm:grid-cols-2 gap-1 text-[11px] font-mono text-muted">
            {dataSources.map(s => (
              <li key={s} className="flex items-center gap-2">
                <span className="text-accent/70">›</span>
                <span className="truncate text-white/75">{s}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle><Cog className="h-4 w-4 inline mr-1.5 text-ok" /> Bereits aktiv</CardTitle>
          <CardDesc>Auch im Stub-Zustand bereits durchgesetzt.</CardDesc>
        </CardHeader>
        <ul className="grid sm:grid-cols-2 gap-1.5 text-xs text-white/75">
          {(alreadyActive ?? [
            '3-Gate Auth (Role · DevSession · requireDev)',
            'Sidebar-Integration & Routing',
            'Audit-Trail fuer Zugriffe (DB)',
            'Rate-Limit + Brute-Force-Schutz',
          ]).map(f => (
            <li key={f} className="flex items-start gap-2">
              <span className="text-ok mt-0.5">✓</span>
              <span>{f}</span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
