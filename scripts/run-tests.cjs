const { spawnSync } = require('node:child_process');

const incoming = process.argv.slice(2).filter((arg) => arg !== '--forceExit');
const args = [...incoming];
if (!args.includes('--coverage')) args.push('--coverage');
if (!args.includes('--detectOpenHandles')) args.push('--detectOpenHandles');

const jestBin = require.resolve('jest/bin/jest');
const result = spawnSync(process.execPath, [jestBin, ...args], {
  cwd: process.cwd(),
  env: process.env,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
});

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);

if (result.error) {
  console.error(result.error);
  process.exit(1);
}

if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1);

const output = `${result.stdout || ''}\n${result.stderr || ''}`;
const leakPatterns = [
  /Jest has detected the following \d+ open handle/i,
  /did not exit one second after the test run/i,
  /failed to exit gracefully/i,
  /Force exiting Jest/i,
];

if (leakPatterns.some((pattern) => pattern.test(output))) {
  console.error('\nF-013 gate: Jest reported leaked/open handles. Test run rejected.');
  process.exit(1);
}
