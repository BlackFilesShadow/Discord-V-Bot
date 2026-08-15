import fs from 'node:fs';
import path from 'node:path';

describe('strict command loader collision invariant', () => {
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
});
