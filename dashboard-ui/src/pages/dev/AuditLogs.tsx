import { ToolStub } from './_ToolStub';

export default function Page() {
  return (
    <ToolStub
      title="Audit Logs"
      desc="Globale Audit-Trail-Suche und Export."
      features={[
        "Volltextsuche ueber alle Audit-Eintraege",
        "Filter nach Kategorie / User / Guild / Zeit",
        "CSV/JSON-Export",
        "Anomalie-Highlighting"
      ]}
    />
  );
}
