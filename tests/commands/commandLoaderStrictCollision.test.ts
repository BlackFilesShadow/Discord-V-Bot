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
