import fs from 'node:fs';
import path from 'node:path';

const worker = fs.readFileSync(
  path.resolve(process.cwd(), 'src/modules/nitrado/jobWorker.ts'),
  'utf8',
);

describe('Nitrado-1M remote failure/status matrix gate', () => {
  it('haelt 429 transient und andere 4xx permanent', () => {
    const catchBlock = worker.indexOf('const httpStatus = e instanceof NitradoApiError ? e.status : null;');
    const permanent = worker.indexOf('const permanent =', catchBlock);
    const taxonomy = worker.indexOf('httpStatus >= 400 && httpStatus < 500 && httpStatus !== 429', permanent);
    const fail = worker.indexOf('await failJob(', taxonomy);

    expect(catchBlock).toBeGreaterThanOrEqual(0);
    expect(permanent).toBeGreaterThan(catchBlock);
    expect(taxonomy).toBeGreaterThan(permanent);
    expect(fail).toBeGreaterThan(taxonomy);
  });

  it('laesst 5xx und statuslose Transportfehler ueber bounded failJob laufen', () => {
    expect(worker).toContain('const httpStatus = e instanceof NitradoApiError ? e.status : null;');
    expect(worker).toContain('const dead = permanent || nextAttempts >= maxAttempts;');
    expect(worker).toContain('const backoffSec = BACKOFF_BASE_SECONDS * Math.pow(2, nextAttempts - 1);');
    expect(worker).not.toMatch(/httpStatus\s*>?=\s*500[^\n]*permanent/i);
  });

  it('startet Keep-Online nur bei exakt stopped', () => {
    const restartCase = worker.indexOf("case 'RESTART_IF_DOWN': {");
    const statusRead = worker.indexOf('const status = await client.getServiceStatus(conn.nitradoServerId);', restartCase);
    const stoppedOnly = worker.indexOf("if (status === 'stopped') {", statusRead);
    const freshGuard = worker.indexOf('const freshKeepOnline = await prisma.nitradoConnection.findFirst({', stoppedOnly);
    const start = worker.indexOf('await client.start(conn.nitradoServerId);', freshGuard);
    const elseBranch = worker.indexOf('} else {', start);

    expect(restartCase).toBeGreaterThanOrEqual(0);
    expect(statusRead).toBeGreaterThan(restartCase);
    expect(stoppedOnly).toBeGreaterThan(statusRead);
    expect(freshGuard).toBeGreaterThan(stoppedOnly);
    expect(start).toBeGreaterThan(freshGuard);
    expect(elseBranch).toBeGreaterThan(start);
  });

  it('erneuert den Claim unmittelbar vor jeder Keep-Online-Remote-Mutation', () => {
    const restartCase = worker.indexOf("case 'RESTART_IF_DOWN': {");
    const stoppedOnly = worker.indexOf("if (status === 'stopped') {", restartCase);
    const ensureOwned = worker.indexOf('await ensureClaimOwned();', stoppedOnly);
    const start = worker.indexOf('await client.start(conn.nitradoServerId);', ensureOwned);

    expect(ensureOwned).toBeGreaterThan(stoppedOnly);
    expect(start).toBeGreaterThan(ensureOwned);
    expect(worker.slice(ensureOwned, start)).not.toContain('transitionClaimedNitradoJob');
  });
});
