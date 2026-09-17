import { useState, type ComponentProps } from 'react';
import { LogOut, Settings2, Sparkles } from 'lucide-react';
import { WelcomeTab as WelcomeCoreTab } from './WelcomeCoreTab';
import { GoodbyePanel } from './GoodbyePanel';
import { LeaveCleanupPanel } from './LeaveCleanupPanel';
import { WelcomeReadOnlyPanel } from './WelcomeReadOnlyPanel';
import { SectionTabs, type SectionTabItem } from './ui/SectionTabs';

type WelcomeTabProps = ComponentProps<typeof WelcomeCoreTab>;
type LifecycleSection = 'welcome' | 'goodbye' | 'cleanup';

const LIFECYCLE_SECTIONS: ReadonlyArray<SectionTabItem<LifecycleSection>> = [
  { key: 'welcome', label: 'Willkommen', icon: Sparkles },
  { key: 'goodbye', label: 'Bye Bye', icon: LogOut },
  { key: 'cleanup', label: 'Cleanup', icon: Settings2 },
];

/**
 * Welcome, Goodbye und Leave-Cleanup bleiben fachlich eine gemeinsame
 * Member-Lifecycle-Oberflaeche. Die Unter-Navigation steuert ausschliesslich,
 * welcher bereits vorhandene Funktionsblock sichtbar ist; API-, Permission-
 * und Mutationslogik bleibt in den jeweiligen Komponenten unveraendert.
 *
 * `welcome.view` ist weiterhin ein echter Read-only-Vertrag. Viewer erhalten
 * deshalb unveraendert die bestehende Read-only-Oberflaeche, ohne manage-only
 * Lookups oder Mutationen auszuloesen.
 */
export function WelcomeTab(props: WelcomeTabProps) {
  const [section, setSection] = useState<LifecycleSection>('welcome');

  if (!props.canManage) {
    return <WelcomeReadOnlyPanel guildId={props.guildId} />;
  }

  return (
    <div className="space-y-5">
      <SectionTabs
        value={section}
        items={LIFECYCLE_SECTIONS}
        onChange={setSection}
        ariaLabel="Willkommen-Funktionen"
      />

      {section === 'welcome' && <WelcomeCoreTab {...props} />}
      {section === 'goodbye' && <GoodbyePanel {...props} />}
      {section === 'cleanup' && <LeaveCleanupPanel guildId={props.guildId} />}
    </div>
  );
}
