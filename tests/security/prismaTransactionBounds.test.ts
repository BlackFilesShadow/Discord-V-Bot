import fs from 'node:fs';
import path from 'node:path';

const prismaSource = fs.readFileSync(path.join(process.cwd(), 'src', 'database', 'prisma.ts'), 'utf8');

describe('Prisma interactive transaction bounds', () => {
  it('setzt explizite maxWait- und timeout-Grenzen statt Prisma-Defaults zu verwenden', () => {
    expect(prismaSource).toContain('transactionOptions:');
    expect(prismaSource).toContain('maxWait: 5_000');
    expect(prismaSource).toContain('timeout: 15_000');
  });
});
