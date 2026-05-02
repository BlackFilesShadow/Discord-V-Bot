import { ToolStub } from './_ToolStub';

export default function Page() {
  return (
    <ToolStub
      title="Command Diagnose"
      desc="Slash-Command-Registry, Cooldowns, Fehler."
      features={[
        "Registrierte Commands je Guild",
        "Cooldown-Auslastung",
        "Letzte Fehler pro Command",
        "Permissions-Check pro Command"
      ]}
    />
  );
}
