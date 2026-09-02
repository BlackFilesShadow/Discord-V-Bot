import { BlackMarketPanel } from './BlackMarketPanel';
import { LotteryPanel } from './LotteryPanel';
import { SystemAccountsOverview } from './SystemAccountsOverview';
import { VirtualAccountsControlPanel } from './VirtualAccountsControlPanel';

export function VirtualAccountsPanel({ guildId, slot }: { guildId: string; slot: string }) {
  return (
    <div className="space-y-6">
      <VirtualAccountsControlPanel guildId={guildId} slot={slot} />
      <SystemAccountsOverview guildId={guildId} slot={slot} />
      <LotteryPanel guildId={guildId} slot={slot} />
      <BlackMarketPanel guildId={guildId} slot={slot} />
    </div>
  );
}
