import fs from 'node:fs';
import path from 'node:path';

describe('strict command loader invariants', () => {
  const source = fs.readFileSync(path.resolve(process.cwd(), 'src/commands/handler.ts'), 'utf8');

  it('verwendet einen eigenen Collision-Fehlertyp und laesst ihn nicht im generischen Datei-Catch verschwinden', () => {
    expect(source).toContain('class CommandCollisionError extends Error');
    expect(source).toContain('throw new CommandCollisionError(');
    expect(source).toContain('if (error instanceof CommandCollisionError) throw error;');
  });

  it('toleriert Kollisionen und Modul-Ladefehler nur bei explizitem COMMAND_LOADER_STRICT=false', () => {
    expect(source).toContain("const strict = process.env.COMMAND_LOADER_STRICT !== 'false'");
    expect(source).toContain('if (strict) {');
    expect(source).toContain('throw error instanceof Error');
    expect(source).toContain('wurde nur wegen COMMAND_LOADER_STRICT=false uebersprungen');
  });

  it('erkennt eine Kollision auch, wenn beide Exporte aus derselben Datei stammen', () => {
    // registerCommand() darf eine zweite Registrierung desselben Namens nicht
    // stillschweigend uebernehmen, nur weil sourceFile identisch mit dem ersten
    // Eintrag ist (z.B. zwei Named Exports einer Datei, die nach der
    // PUBLIC_COMMAND_RENAMES-Kanonisierung auf denselben Namen fallen).
    expect(source).toContain('const existing = commandSources.get(cmd.data.name);');
    expect(source).toContain('if (existing) {');
    expect(source).not.toContain("if (existing && existing !== sourceFile) {");
  });

  it('baut einen neuen Snapshot und ersetzt die aktive Runtime-Registry erst am Ende', () => {
    const create = source.indexOf('const nextCommands = new Collection<string, Command>()');
    const populate = source.indexOf('nextCommands.set(cmd.data.name, cmd)');
    const strictRethrow = source.indexOf('throw error instanceof Error');
    const commit = source.indexOf('client.commands = nextCommands');
    expect(create).toBeGreaterThanOrEqual(0);
    expect(populate).toBeGreaterThan(create);
    expect(strictRethrow).toBeGreaterThan(populate);
    expect(commit).toBeGreaterThan(strictRethrow);
    expect(source.slice(0, commit)).not.toContain('client.commands = new Collection');
  });
});
