import { ToolStub } from './_ToolStub';

export default function Page() {
  return (
    <ToolStub
      title="Fehler Monitoring"
      desc="Live-Errors aus errorSink (Discord-Webhook)."
      features={[
        "Live-Stream errorSink-Events",
        "Gruppierung nach Stack-Fingerprint",
        "Top-Fehler letzte 24h",
        "Filter nach Severity / Quelle"
      ]}
    />
  );
}
