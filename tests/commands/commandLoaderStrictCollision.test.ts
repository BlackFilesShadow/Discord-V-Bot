import fs from 'node:fs';
import path from 'node:path';

describe('strict command loader invariants', () => {
  const source = fs.readFileSync(path.resolve(process.cwd(), 'src/commands/handler.ts'), 'utf8');

  it('verwendet einen eigenen Collision-Fehlertyp und laesst ihn nicht im generischen Datei-Catch verschwinden', () => {
    expect(source).toContain('class CommandCollisionError extends Error');
    expect(source).toContain('throw new CommandCollisionError(');
    expect(source).toContain('if (error instanceof CommandCollisionError) throw error;');
  });

  it('toleriert Kollisionen nur bei explizitem COMMAND_LOADER_STRICT=false', () => {
    expect(source).toContain("process.env.COMMAND_LOADER_STRICT !== 'false'");
    expect(source).toContain('COMMAND_LOADER_STRICT=false');
  });

  it('baut einen neuen Snapshot und ersetzt die aktive Runtime-Registry erst am Ende', () => {
    const create = source.indexOf('const nextCommands = new Collection<string, Command>()');
    const populate = source.indexOf('nextCommands.set(cmd.data.name, cmd)');
    const commit = source.indexOf('client.commands = nextCommands');
    expect(create).toBeGreaterThanOrEqual(0);
    expect(populate).toBeGreaterThan(create);
    expect(commit).toBeGreaterThan(populate);
    expect(source.slice(0, commit)).not.toContain('client.commands = new Collection');
  });
});
