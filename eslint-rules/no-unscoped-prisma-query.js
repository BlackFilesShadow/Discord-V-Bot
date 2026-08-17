/**
 * DB-1 Tenant-Isolation-Rule.
 *
 * Verbietet `prisma.<scopedModel>.<query/mutation>()` ohne statisch belegbaren
 * `guildId`-Scope im `where`. Fuer den Produktionsmodus `set: all` werden alle
 * Models mit direktem guildId automatisch aus prisma/schema.prisma abgeleitet.
 *
 * Dynamische Argumentobjekte werden bewusst fail-closed gemeldet: Wenn der
 * Linter den Scope nicht sehen kann, darf die Query nicht stillschweigend als
 * sicher gelten. Bewusste globale Systemaggregation braucht einen lokalen,
 * begruendeten eslint-disable an der exakten Zeile.
 */

const fs = require('fs');
const path = require('path');

const STRICT_MODELS = [
  'nitradoConnection', 'guildPermissionGrant', 'serverSettings', 'faction',
  'factionMember', 'whitelistEntry', 'whitelistRequest', 'economyConfig',
  'economyAccount', 'economyTransaction', 'gameIdentityLink', 'casinoGame',
  'casinoRound', 'idempotencyKey', 'nitradoJob', 'killfeedConfig', 'killfeedEvent',
];

function deriveGuildModels() {
  try {
    const schemaPath = path.resolve(__dirname, '..', 'prisma', 'schema.prisma');
    const src = fs.readFileSync(schemaPath, 'utf8');
    const models = new Set();
    const re = /model\s+(\w+)\s*\{([\s\S]*?)\n\}/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      if (/\n\s*guildId\s+\S/.test(m[2])) {
        models.add(m[1].charAt(0).toLowerCase() + m[1].slice(1));
      }
    }
    return models;
  } catch {
    return new Set();
  }
}

const DERIVED_GUILD_MODELS = deriveGuildModels();

function resolveModelSet(setName) {
  const strict = new Set(STRICT_MODELS);
  if (setName === 'extras') {
    const extras = new Set();
    for (const m of DERIVED_GUILD_MODELS) if (!strict.has(m)) extras.add(m);
    return extras;
  }
  if (setName === 'all') {
    const all = new Set(strict);
    for (const m of DERIVED_GUILD_MODELS) all.add(m);
    return all;
  }
  return strict;
}

const QUERY_METHODS = new Set([
  'findMany', 'findFirst', 'findUnique', 'findFirstOrThrow', 'findUniqueOrThrow',
  'count', 'aggregate', 'groupBy',
  'update', 'updateMany', 'upsert',
  'delete', 'deleteMany',
]);

function objectHasGuildIdKey(node) {
  if (!node || node.type !== 'ObjectExpression') return false;
  for (const prop of node.properties) {
    if (prop.type !== 'Property' || prop.computed) continue;
    const keyName = prop.key.name ?? prop.key.value;
    if (keyName === 'guildId') return true;
    if (typeof keyName === 'string' && keyName.startsWith('guildId_')) return true;
    if (prop.value && prop.value.type === 'ObjectExpression' && objectHasGuildIdKey(prop.value)) return true;
    if ((keyName === 'AND' || keyName === 'OR') && prop.value.type === 'ArrayExpression') {
      if (prop.value.elements.some(e => objectHasGuildIdKey(e))) return true;
    }
  }
  return false;
}

function callTargetsScopedModel(callee, scopedModels) {
  if (callee.type !== 'MemberExpression') return null;
  const method = callee.property.name;
  if (!QUERY_METHODS.has(method)) return null;
  const modelExpr = callee.object;
  if (modelExpr.type !== 'MemberExpression') return null;
  const modelName = modelExpr.property.name;
  if (!scopedModels.has(modelName)) return null;
  const root = modelExpr.object;
  if (root.type !== 'Identifier') return null;
  if (!/^_?(prisma|tx|trx)\b/i.test(root.name)) return null;
  return { modelName, method };
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Verbietet Prisma-Queries auf Guild-scoped Models ohne statisch belegbaren guildId-Scope',
    },
    messages: {
      missingGuildId:
        'prisma.{{model}}.{{method}}() ohne `guildId` im where — Cross-Guild-Leak moeglich.',
      missingArg:
        'prisma.{{model}}.{{method}}() ohne Argument — Scope kann nicht geprueft werden.',
      dynamicArg:
        'prisma.{{model}}.{{method}}() nutzt dynamische Argumente — `guildId`-Scope ist statisch nicht belegbar.',
    },
    schema: [{
      type: 'object',
      properties: { set: { enum: ['strict', 'extras', 'all'] } },
      additionalProperties: false,
    }],
  },
  create(context) {
    const setName = (context.options[0] && context.options[0].set) || 'strict';
    const scopedModels = resolveModelSet(setName);
    return {
      CallExpression(node) {
        const target = callTargetsScopedModel(node.callee, scopedModels);
        if (!target) return;
        const arg = node.arguments[0];
        const reportData = { model: target.modelName, method: target.method };
        if (!arg) {
          context.report({ node, messageId: 'missingArg', data: reportData });
          return;
        }
        if (arg.type !== 'ObjectExpression') {
          context.report({ node, messageId: 'dynamicArg', data: reportData });
          return;
        }
        const whereProp = arg.properties.find(
          p => p.type === 'Property' && !p.computed
            && (p.key.name === 'where' || p.key.value === 'where'),
        );
        if (!whereProp) {
          context.report({ node, messageId: 'missingGuildId', data: reportData });
          return;
        }
        if (!objectHasGuildIdKey(whereProp.value)) {
          context.report({ node, messageId: 'missingGuildId', data: reportData });
        }
      },
    };
  },
};
