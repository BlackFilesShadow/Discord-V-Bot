import type { ComponentProps } from 'react';
import { WelcomeTab as WelcomeCoreTab } from './WelcomeCoreTab';
import { GoodbyePanel } from './GoodbyePanel';
import { LeaveCleanupPanel } from './LeaveCleanupPanel';

type WelcomeTabProps = ComponentProps<typeof WelcomeCoreTab>;

/**
 * Welcome, Goodbye und der optionale Leave-Reset bleiben eine gemeinsame
 * Member-Lifecycle-Oberflaeche. Das bestehende Onboarding bleibt isoliert;
 * der destruktive Cleanup-Schalter entscheidet seinen Owner-Status selbst.
 */
export function WelcomeTab(props: WelcomeTabProps) {
  return (
    <div className="space-y-6">
      <WelcomeCoreTab {...props} />
      <GoodbyePanel {...props} />
      <LeaveCleanupPanel guildId={props.guildId} />
    </div>
  );
}
