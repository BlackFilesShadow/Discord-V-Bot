#!/usr/bin/env node
/**
 * Resolve a usable bash on Windows (prefer Git Bash over WSL stub).
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function exists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function candidates() {
  const out = [];
  if (process.env.GIT_BASH && process.env.GIT_BASH.trim()) out.push(process.env.GIT_BASH.trim());
  if (process.env.BASH_PATH && process.env.BASH_PATH.trim()) out.push(process.env.BASH_PATH.trim());
  const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env.LOCALAPPDATA || '';
  out.push(
    path.join(pf, 'Git', 'bin', 'bash.exe'),
    path.join(pf, 'Git', 'usr', 'bin', 'bash.exe'),
    path.join(pf86, 'Git', 'bin', 'bash.exe'),
    path.join(local, 'Programs', 'Git', 'bin', 'bash.exe'),
  );
  // PATH bash last — may be WSL stub on Windows
  out.push('bash');
  return out;
}

function isUsable(bashPath) {
  const r = spawnSync(bashPath, ['-c', 'echo ok'], { encoding: 'utf8' });
  if (r.status !== 0) return false;
  const combined = `${r.stdout || ''}${r.stderr || ''}`;
  if (/Windows Subsystem for Linux/i.test(combined)) return false;
  if (/no installed distributions/i.test(combined)) return false;
  return /ok/.test(combined);
}

function resolveBash() {
  for (const c of candidates()) {
    if (c !== 'bash' && !exists(c)) continue;
    if (isUsable(c)) return c;
  }
  return null;
}

if (require.main === module) {
  const bash = resolveBash();
  if (!bash) {
    console.error('No usable bash found. Install Git for Windows or set GIT_BASH.');
    process.exit(1);
  }
  process.stdout.write(bash);
}

module.exports = { resolveBash, isUsable };
