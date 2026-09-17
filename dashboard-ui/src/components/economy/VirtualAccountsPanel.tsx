import { useState } from 'react';
import { Banknote, Landmark, ShoppingCart, Ticket } from 'lucide-react';
import { SectionTabs, type SectionTabItem } from '@/components/ui/SectionTabs';
import { BlackMarketPanel } from './BlackMarketPanel';
import { LotteryPanel } from './LotteryPanel';
import { SystemAccountsOverview } from './SystemAccountsOverview';
import { VirtualAccountsControlPanel } from './VirtualAccountsControlPanel';

type VirtualAccountsSection = 'accounts' | 'system' | 'lottery' | 'market';

const SECTIONS: ReadonlyArray<SectionTabItem<VirtualAccountsSection>> = [
  { key: 'accounts', label: 'Konten', icon: Banknote },
  { key: 'system', label: 'Systemkonten', icon: Landmark },
  { key: 'lottery', label: 'Lotterie', icon: Ticket },
  { key: 'market', label: 'Schwarzmarkt', icon: ShoppingCart },
];

export function VirtualAccountsPanel({ guildId, slot }: { guildId: string; slot: string }) {
  const [section, setSection] = useState<VirtualAccountsSection>('accounts');
  const [openTreasuryConfiguration, setOpenTreasuryConfiguration] = useState(false);

  return (
    <div className="space-y-5">
      <SectionTabs
        value={section}
        items={SECTIONS}
        onChange={setSection}
        ariaLabel="Virtuelle-Konten-Funktionen"
      />

      {/*
       * Alle Fachkomponenten bleiben gemountet. Die Unter-Navigation aendert nur
       * die Sichtbarkeit, damit lokale Entwuerfe/Editor-Zustaende beim Wechsel
       * nicht verloren gehen und bestehende Query-/Mutation-Logik unveraendert bleibt.
       */}
      <section hidden={section !== 'accounts'} aria-label="Virtuelle Konten">
        <VirtualAccountsControlPanel
          guildId={guildId}
          slot={slot}
          openTreasuryConfiguration={openTreasuryConfiguration}
          onTreasuryConfigurationOpened={() => setOpenTreasuryConfiguration(false)}
        />
      </section>

      <section hidden={section !== 'system'} aria-label="Systemkonten">
        <SystemAccountsOverview
          guildId={guildId}
          slot={slot}
          onConfigureServerBank={() => {
            setOpenTreasuryConfiguration(true);
            setSection('accounts');
          }}
        />
      </section>

      <section hidden={section !== 'lottery'} aria-label="Lotterie">
        <LotteryPanel guildId={guildId} slot={slot} />
      </section>

      <section hidden={section !== 'market'} aria-label="Schwarzmarkt">
        <BlackMarketPanel guildId={guildId} slot={slot} />
      </section>
    </div>
  );
}
