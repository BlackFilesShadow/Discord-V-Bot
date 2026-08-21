/** Stage 47 — structural runtime baseline II check (no live DB required). */
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const prisma = read('src/database/prisma.ts');
const pkg = JSON.parse(read('package.json'));
const hasRedisDep = Boolean(pkg.dependencies?.ioredis || pkg.dependencies?.redis || pkg.devDependencies?.ioredis);
const out = {
  stage: 47,
  prismaSingleton: /PrismaClient/.test(prisma),
  redisConfiguredInEnvExample: /REDIS_URL/.test(read('.env.example')),
  hasRedisDependency: hasRedisDep,
  nitradoJobModel: /model NitradoJob/.test(read('prisma/schema.prisma')),
};
if (!out.prismaSingleton || !out.redisConfiguredInEnvExample || !out.nitradoJobModel) {
  console.error(JSON.stringify(out, null, 2));
  process.exit(1);
}
console.log(JSON.stringify(out, null, 2));
