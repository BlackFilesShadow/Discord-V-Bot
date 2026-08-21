import fs from 'node:fs';
import { normalizeSourceNewlines } from '../helpers/sourceText';
import path from 'node:path';

const read = (relative: string) => normalizeSourceNewlines(fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8'));

const devRouteSource = read('src/dashboard/routes/v2/dev.ts');
const devSocketSource = read('src/dashboard/socket/dev.ts');
const emitterSource = read('src/dashboard/socket/emitter.ts');
const clientSocketSource = read('dashboard-ui/src/lib/socket.ts');
const devSessionSource = read('dashboard-ui/src/lib/devSession.tsx');
const liveBotStatusSource = read('dashboard-ui/src/pages/dev/LiveBotStatus.tsx');

describe('Dashboard-2B DEV realtime architecture', () => {
  test('socket handshake is fail-closed on the current DB user and pins the exact DevSession id', () => {
    expect(devSocketSource).not.toContain("dbUser?.role ?? session.role ?? 'USER'");
    expect(devSocketSource).toContain("if (!dbUser || !isGlobalDeveloperEligible(session.discordId, dbUser.role))");
    expect(devSocketSource).toContain('data.devUserId = session.userId;');
    expect(devSocketSource).toContain('data.devUserDiscordId = session.discordId;');
    expect(devSocketSource).toContain('data.devSessionId = dev.id;');
  });

  test('connected DEV sockets are continuously revalidated against role + exact active session', () => {
    expect(devSocketSource).toContain('const DEV_AUTH_RECHECK_MS = 1_000;');
    expect(devSocketSource).toContain('isDevSocketAccessCurrent(socket)');
    expect(devSocketSource).toMatch(/id:\s*data\.devSessionId,[\s\S]*userDiscordId:\s*data\.devUserDiscordId,[\s\S]*revokedAt:\s*null,[\s\S]*expiresAt:\s*\{ gt: new Date\(\) \}/);
    expect(devSocketSource).toContain('socket.disconnect(true);');
    expect(devSocketSource).toMatch(/if \(!dbUser \|\| !isGlobalDeveloperEligible\(data\.devUserDiscordId, dbUser\.role\)\) \{[\s\S]*revokeActiveSessionsFailClosed\(data\.devUserDiscordId\);[\s\S]*return false;/);
  });

  test('HTTP status also revokes stale step-up sessions when global DEV identity is lost', () => {
    const statusBlock = devRouteSource.match(/devRouter\.get\('\/status'[\s\S]*?\n\}\);/)?.[0] ?? '';
    expect(statusBlock).toContain("if (!isGlobalDeveloperEligible(String(req.auth.discordId), currentRole)) {");
    const deniedBlock = statusBlock.match(/if \(!isGlobalDeveloperEligible[\s\S]*?\n  \}/)?.[0] ?? '';
    expect(deniedBlock).toContain('await revokeActiveDevSessions(String(req.auth.discordId));');
  });

  test('DEV live logs pass the canonical recursive redactor before namespace emit', () => {
    expect(emitterSource).toContain("import { redactAuditDetails } from '../../utils/auditRedaction';");
    expect(emitterSource).toContain("io.of('/dev').emit('log', sanitizeDevLogLine(line));");
    expect(emitterSource).not.toContain("io.of('/dev').emit('log', line);");
    expect(emitterSource).toContain('DEV_LOG_CIRCULAR');
    expect(emitterSource).toContain('DEV_LOG_MAX_DEPTH');
  });

  test('client drops the privileged socket whenever DEV status is lost or logout starts', () => {
    expect(clientSocketSource).toContain('export function disconnectDevSocket(): void');
    expect(clientSocketSource).toContain('devSocket.removeAllListeners();');
    expect(clientSocketSource).toContain('devSocket.disconnect();');
    expect(clientSocketSource).toContain('devSocket = null;');
    expect(devSessionSource).toContain("import { disconnectDevSocket } from './socket';");
    expect(devSessionSource).toContain('if (!s.active || !s.eligible) disconnectDevSocket();');

    const catchBlock = devSessionSource.match(/catch \{[\s\S]*?\} finally/)?.[0] ?? '';
    expect(catchBlock).toContain('disconnectDevSocket();');

    const logoutBlock = devSessionSource.match(/const logout = useCallback[\s\S]*?\}, \[\]\);/)?.[0] ?? '';
    expect(logoutBlock.indexOf('disconnectDevSocket();')).toBeGreaterThan(-1);
    expect(logoutBlock.indexOf('disconnectDevSocket();')).toBeLessThan(logoutBlock.indexOf("api.post('/api/v2/dev/logout')"));
  });

  test('LiveBotStatus consumes the canonical numeric ts schema and rejects malformed socket payloads', () => {
    expect(liveBotStatusSource).toContain('ts: number;');
    expect(liveBotStatusSource).not.toContain('timestamp?: string;');
    expect(liveBotStatusSource).toContain('const onLog = (raw: unknown): void =>');
    expect(liveBotStatusSource).toContain('const line = asLogLine(raw);');
    expect(liveBotStatusSource).toContain('if (!line) return;');
    expect(liveBotStatusSource).toContain('{fmtLogTime(l.ts)}');
  });
});
