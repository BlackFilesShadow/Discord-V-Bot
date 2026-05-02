import { ToolStub } from './_ToolStub';

export default function Page() {
  return (
    <ToolStub
      title="Sicherheitsstatus"
      desc="Rate-Limit-Hits, Brute-Force, Audit-Anomalien."
      features={[
        "DEV_LOGIN_FAILED letzte 24h",
        "Brute-Force-Locks",
        "GUILD_PERM_DENIED-Cluster",
        "2FA-Verifizierungen"
      ]}
    />
  );
}
