import prisma from '../database/prisma';
import { runDatabaseConsistencyScan } from '../database/consistencyScanner';

async function main(): Promise<void> {
  const report = await runDatabaseConsistencyScan();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

  if (report.status === 'INVALID') {
    process.exitCode = 2;
    return;
  }
  if (report.status === 'DEGRADED') {
    process.exitCode = 1;
  }
}

void main()
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`DB consistency scanner failed: ${message}\n`);
    process.exitCode = 3;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
