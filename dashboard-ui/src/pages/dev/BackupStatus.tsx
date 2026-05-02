import { ToolStub } from './_ToolStub';

export default function Page() {
  return (
    <ToolStub
      title="Backup Status"
      desc="Letzte Backups, Verifikation, Restore-Test."
      features={[
        "Letzte erfolgreiche Backups",
        "Backup-Groesse und Aufbewahrung",
        "Verifikation per backup-verify.sh",
        "Restore-Test (read-only)"
      ]}
    />
  );
}
