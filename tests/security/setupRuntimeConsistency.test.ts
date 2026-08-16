import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const setup = fs.readFileSync(path.join(root, 'deploy', 'setup.sh'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
  main?: string;
  scripts?: Record<string, string>;
};

describe('Bare-metal setup runtime consistency', () => {
  it('startet exakt denselben kompilierten Entry-Point wie package.json', () => {
    expect(pkg.main).toBe('dist/src/index.js');
    expect(pkg.scripts?.start).toBe('node dist/src/index.js');
    expect(setup).toContain('ExecStart=/usr/bin/node dist/src/index.js');
    expect(setup).not.toContain('ExecStart=/usr/bin/node dist/index.js');
  });

  it('installiert Build-Dependencies fuer Backend und Dashboard vor dem Build', () => {
    expect(setup).toContain('npm ci --no-audit --no-fund');
    expect(setup).toContain("cd '$BOT_DIR/dashboard-ui' && npm ci --no-audit --no-fund");
    expect(setup).toContain('npm run build');
    expect(setup).toContain('npm prune --omit=dev --no-audit --no-fund');
  });

  it('erzeugt einen 32-Byte Encryption-Key und gibt private Runtime-Pfade frei', () => {
    expect(setup).toContain('ENCRYPTION_KEY=$(openssl rand -hex 32)');
    expect(setup).toContain('"$BOT_DIR/private/dev-logs"');
    expect(setup).toContain('"$BOT_DIR/private/exports"');
    expect(setup).toContain('ReadWritePaths=${BOT_DIR}/uploads ${BOT_DIR}/logs ${BOT_DIR}/private');
  });

  it('erzeugt neue Installationen mit den kanonischen aktuellen AI-Modellen', () => {
    expect(setup).toContain('GROQ_MODEL=openai/gpt-oss-120b');
    expect(setup).toContain('CEREBRAS_MODEL=gpt-oss-120b');
    expect(setup).toContain('OPENROUTER_MODEL=meta-llama/llama-3.3-70b-instruct:free');
    expect(setup).toContain('GEMINI_MODEL=gemini-3.6-flash');
    expect(setup).toContain('OPENAI_MODEL=gpt-5.6-luna');
    expect(setup).not.toContain('GROQ_MODEL=llama-3.3-70b-versatile');
    expect(setup).not.toContain('GEMINI_MODEL=gemini-2.0-flash');
    expect(setup).not.toContain('OPENAI_MODEL=gpt-4\n');
  });

  it('aktualisiert bestehende Checkouts nur per Fast-Forward und migriert kanonisch', () => {
    expect(setup).toContain('git pull --ff-only origin main');
    expect(setup).toContain('npx prisma migrate deploy');
    expect(setup).not.toContain('prisma db push');
  });
});
