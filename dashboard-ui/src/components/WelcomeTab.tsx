import type { ComponentProps } from 'react';
import { WelcomeTab as WelcomeCoreTab } from './WelcomeCoreTab';
import { GoodbyePanel } from './GoodbyePanel';
import { WelcomeReadOnlyPanel } from './WelcomeReadOnlyPanel';

type WelcomeTabProps = ComponentProps<typeof WelcomeCoreTab>;

/**
 * Welcome, Goodbye und der optionale Leave-Reset bleiben eine gemeinsame
 * Member-Lifecycle-Oberflaeche. Das bestehende Onboarding bleibt isoliert;
 * der destruktive Cleanup-Schalter wird innerhalb des Goodbye-Bereichs
 * angezeigt und entscheidet seinen Owner-Status weiterhin selbst.
 *
 * `welcome.view` ist ein echter Read-only-Vertrag. Ein Viewer darf deshalb
 * Welcome/Goodbye-Konfiguration lesen, ohne dass manage-only Lookups oder
 * Mutationen ausgeloest werden. Der Parent liefert `canManage`; bei false
 * entscheidet der Backend-GET weiterhin fail-closed, ob `welcome.view`
 * tatsaechlich vorhanden ist.
 */
export function WelcomeTab(props: WelcomeTabProps) {
  if (!props.canManage) {
    return <WelcomeReadOnlyPanel guildId={props.guildId} />;
  }

  return (
    <div className="space-y-6">
      <WelcomeCoreTab {...props} />
      <GoodbyePanel {...props} />
    </div>
  );
}
