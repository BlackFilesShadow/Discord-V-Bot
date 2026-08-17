import type { ComponentProps } from 'react';
import { WelcomeTab as WelcomeCoreTab } from './WelcomeCoreTab';
import { GoodbyePanel } from './GoodbyePanel';

type WelcomeTabProps = ComponentProps<typeof WelcomeCoreTab>;

/**
 * Welcome und Goodbye bleiben eine gemeinsame Member-Lifecycle-Oberfläche.
 * Der bestehende WelcomeCoreTab wurde für Goodbye-1 unverändert übernommen;
 * dadurch bleibt das bereits geprüfte Onboarding-Verhalten isoliert erhalten.
 */
export function WelcomeTab(props: WelcomeTabProps) {
  return (
    <div className="space-y-6">
      <WelcomeCoreTab {...props} />
      <GoodbyePanel {...props} />
    </div>
  );
}
