/**
 * Generischer Phase-2-Stub fuer DEV-Tools.
 *
 * Zeigt Titel + Beschreibung des Tools und einen klaren Hinweis,
 * dass die konkrete Implementierung Teil von Phase 2 ist.
 *
 * Wichtig: Stubs sind KEINE Dummy-Funktionen im Sinne von Spec 11
 * ("keine Dummy Funktionen") — sie taeuschen keine Funktionalitaet vor,
 * sondern sind eindeutig als "in Entwicklung" markiert.
 */
import { Construction } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardDesc } from '@/components/ui/Card';

export interface ToolStubProps {
  title: string;
  desc: string;
  /** Optionale Pflichtfunktionen aus der Spec, die in Phase 2 implementiert werden. */
  features?: ReadonlyArray<string>;
}

export function ToolStub({ title, desc, features }: ToolStubProps) {
  return (
    <div className="space-y-4">
      <Card glow>
        <CardHeader>
          <CardTitle><Construction className="h-4 w-4 inline mr-1 text-warn" /> {title}</CardTitle>
          <CardDesc>{desc}</CardDesc>
        </CardHeader>
        <p className="text-xs text-muted">
          Dieses Tool ist Teil der DEV-Konsole, die geplante Implementierung folgt in Phase 2.
          Login, Sitzungsbindung, Sidebar-Integration und Rechtepruefung (Backend + Frontend)
          sind bereits aktiv (Phase 1).
        </p>
      </Card>

      {features && features.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Geplante Pflichtfunktionen</CardTitle>
            <CardDesc>Quelle: Anforderungen — wird in Phase 2 vollstaendig umgesetzt.</CardDesc>
          </CardHeader>
          <ul className="grid sm:grid-cols-2 gap-1.5 text-xs text-muted">
            {features.map(f => (
              <li key={f} className="flex items-start gap-2">
                <span className="text-accent mt-0.5">•</span>
                <span>{f}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
