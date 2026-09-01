import fs from 'node:fs';
import path from 'node:path';

function read(relative: string): string {
  return fs.readFileSync(path.join(process.cwd(), relative), 'utf8');
}

describe('Dashboard drift + auth expiry gate', () => {
  const api = read('dashboard-ui/src/lib/api.ts');
  const auth = read('dashboard-ui/src/lib/auth.tsx');
  const login = read('dashboard-ui/src/pages/Login.tsx');
  const drift = read('dashboard-ui/src/components/NitradoDriftBanner.tsx');

  it('propagates non-/api/me 401 responses and confirms expiry via the canonical session probe', () => {
    expect(api).toContain("export const AUTH_EXPIRED_EVENT = 'vbot:auth-expired'");
    expect(api).toContain("if (pathname === '/api/me') return");
    expect(api).toContain('if (err instanceof ApiError && err.status === 401) notifyAuthExpired(scopedPath, err)');
    expect(api).toContain('window.dispatchEvent(new CustomEvent(AUTH_EXPIRED_EVENT');

    expect(auth).toContain('window.addEventListener(AUTH_EXPIRED_EVENT, onAuthExpired)');
    expect(auth).toContain("api.get<{ user: SessionUser }>('/api/me')");
    expect(auth).toContain('if (pendingRevalidation) return');
    expect(auth).toContain('setUser(null)');
    expect(auth).toContain('setSessionExpired(true)');
  });

  it('shows an explicit login notice only after the session probe confirms expiry', () => {
    expect(auth).toContain('sessionExpired: boolean');
    expect(auth).toContain('setSessionExpired(false)');
    expect(login).toContain('data-testid="session-expired-notice"');
    expect(login).toContain('Sitzung abgelaufen – bitte erneut anmelden.');
  });

  it('never claims a Nitrado drift from a 401 and deduplicates equal probe errors', () => {
    expect(drift).toContain('const hasAuthError = rawErrors.some');
    expect(drift).toContain('if (hasAuthError) return null');
    expect(drift).toContain('const uniqueErrors = Array.from(new Map(');
    expect(drift).toContain("{hasDrift ? 'Manuelle Nitrado-Abweichung erkannt' : 'Nitrado-Driftprüfung fehlgeschlagen'}");
    expect(drift).toContain('Es wurde keine Nitrado-Abweichung bestätigt.');
  });
});
