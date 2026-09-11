import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(
  path.resolve(process.cwd(), 'src/commands/dashboard/whitelist.ts'),
  'utf8',
);

describe('/whitelist request preflight wiring', () => {
  it('blockiert lokale Whitelist und offene Anfrage informativ vor einer neuen Mutation', () => {
    const existing = source.indexOf('const existing = await prisma.whitelistEntry.findFirst');
    const localBlocked = source.indexOf("'Bereits auf der Whitelist'", existing);
    const openSame = source.indexOf('const openSame = await prisma.whitelistRequest.findFirst', localBlocked);
    const pendingBlocked = source.indexOf("'Whitelist-Antrag bereits vorhanden'", openSame);
    const remote = source.indexOf('remoteAlreadyWhitelisted = await isAlreadyOnRemoteWhitelist(', pendingBlocked);
    const claim = source.indexOf('const claim = await claimWhitelistRequest(', remote);

    expect(existing).toBeGreaterThan(-1);
    expect(localBlocked).toBeGreaterThan(existing);
    expect(openSame).toBeGreaterThan(localBlocked);
    expect(pendingBlocked).toBeGreaterThan(openSame);
    expect(remote).toBeGreaterThan(pendingBlocked);
    expect(claim).toBeGreaterThan(remote);
  });

  it('erkennt Remote-only Nitrado-Eintraege und erstellt bei Preflight-Fehler fail-closed keinen Antrag', () => {
    expect(source).toContain("import { isAlreadyOnRemoteWhitelist } from '../../modules/whitelist/whitelistRequestPreflight';");
    expect(source).toContain('if (remoteAlreadyWhitelisted) {');
    expect(source).toContain('steht auf **${targetLabel(target)}** bereits auf der Nitrado-Whitelist');
    expect(source).toContain("'Whitelist-Status nicht pruefbar'");
    expect(source).toContain('Es wurde kein Antrag erstellt. Bitte versuche es erneut.');
  });

  it('laesst die bestehende PENDING_REMOVE-Semantik nur nach einem negativen frischen Remote-Preflight weiterlaufen', () => {
    const remoteBlocked = source.indexOf('if (remoteAlreadyWhitelisted) {');
    const pendingRemove = source.indexOf("if (existing?.syncState === 'PENDING_REMOVE')", remoteBlocked);
    const claim = source.indexOf('const claim = await claimWhitelistRequest(', pendingRemove);
    expect(remoteBlocked).toBeGreaterThan(-1);
    expect(pendingRemove).toBeGreaterThan(remoteBlocked);
    expect(claim).toBeGreaterThan(pendingRemove);
  });

  it('verwendet den transaktionalen Claim als finale Mutation-Grenze und behandelt Race-Ergebnisse explizit', () => {
    expect(source).toContain("import {\n  claimWhitelistRequest,\n  type WhitelistRequestClaimClient,\n} from '../../modules/whitelist/whitelistRequestClaim';");
    expect(source).toContain("if (claim.kind === 'ALREADY_PENDING')");
    expect(source).toContain("if (claim.kind === 'LIMIT_REACHED')");
    expect(source).toContain('const created = claim.request;');
    expect(source).not.toContain('const created = await prisma.whitelistRequest.create');
  });
});
