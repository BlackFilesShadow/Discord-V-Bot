import { useState } from 'react';
import { BlackMarketPanel } from './BlackMarketPanel';
import { LotteryPanel } from './LotteryPanel';
import { SystemAccountsOverview } from './SystemAccountsOverview';
import { VirtualAccountsControlPanel } from './VirtualAccountsControlPanel';

export function VirtualAccountsPanel({ guildId, slot }: { guildId: string; slot: string }) {
  const [openTreasuryConfiguration, setOpenTreasuryConfiguration] = useState(false);

  return (
    <div className="space-y-6">
      <VirtualAccountsControlPanel
        guildId={guildId}
        slot={slot}
        openTreasuryConfiguration={openTreasuryConfiguration}
        onTreasuryConfigurationOpened={() => setOpenTreasuryConfiguration(false)}
      />
      <SystemAccountsOverview guildId={guildId} slot={slot} onConfigureServerBank={() => setOpenTreasuryConfiguration(true)} />
      <LotteryPanel guildId={guildId} slot={slot} />
      <BlackMarketPanel guildId={guildId} slot={slot} />
    </div>
  );
}
