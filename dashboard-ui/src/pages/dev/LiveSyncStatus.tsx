import { ToolStub } from './_ToolStub';

export default function Page() {
  return (
    <ToolStub
      title="Live Sync Status"
      desc="Cross-Service Sync-Jobs (Whitelist, Economy)."
      features={[
        "Whitelist-Sync Bot <-> Nitrado",
        "Economy-Link Status pro Server",
        "Faction-Asset-Sync",
        "Letzter Lauf je Job + Naechster"
      ]}
    />
  );
}
