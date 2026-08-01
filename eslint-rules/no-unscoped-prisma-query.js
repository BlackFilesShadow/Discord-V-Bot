/**
 * Custom-ESLint-Rule (Phase 3.5 Isolation-Doktrin):
 * Verbietet `prisma.<scopedModel>.findMany|findFirst|findUnique|update|...`
 * **ohne** `guildId` im `where:`. Verhindert vergessene Cross-Guild-Queries.
 *
 * Heuristik (AST-basiert, ohne Type-Info):
 *   - Call-Expression auf `prisma.<MODEL>.<METHOD>(...)` oder `tx.<MODEL>.<METHOD>(...)`
 *   - MODEL muss in SCOPED_MODELS stehen
 *   - METHOD muss eine Query/Mutation sein
 *   - Erstes Argument muss ein Object-Literal sein, das eine `where`-Property
 *     mit `guildId`-Key enthaelt (rekursiv via AND/OR ist erlaubt).
 *
 * Falsche Use-Cases (z.B. groupBy ohne where) werden bewusst gemeldet —
 * dafuer Inline-Disable mit `// eslint-disable-next-line no-unscoped-prisma-query`.
 */

const fs = require('fs');
const path = require('path');

/**
 * Tenant-kritische Models: hier ist ein fehlendes `guildId` im where ein
 * harter Fehler (Cross-Guild-Leak in Economy/Nitrado/Whitelist/Killfeed/…).
 */
const STRICT_MODELS = [
  'nitradoConnection', 'guildPermissionGrant', 'serverSettings', 'faction',
  'factionMember', 'whitelistEntry', 'whitelistRequest', 'economyConfig',
  'economyAccount', 'economyTransaction', 'economyLink', 'casinoGame',
  'casinoRound', 'idempotencyKey', 'nitradoJob', 'killfeedConfig', 'killfeedEvent',
];

/**
 * Alle weiteren Models mit `guildId`-Feld werden aus prisma/schema.prisma
 * abgeleitet (F-005: keine manuelle Liste, kein Drift). Fuer diese greift die
 * Regel als Advisory-Warnung, bis jede Query auditiert ist.
 */
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
  return strict; // default: strict
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
    // Composite-Unique-Key Prismas: `guildId_userDiscordId`, `guildId_slot`, ...
    if (typeof keyName === 'string' && keyName.startsWith('guildId_')) return true;
    // Wert kann ein Object sein, das guildId enthaelt (verschachtelt fuer compound keys)
    if (prop.value && prop.value.type === 'ObjectExpression' && objectHasGuildIdKey(prop.value)) return true;
    // Nested AND/OR — rekursiv pruefen
    if ((keyName === 'AND' || keyName === 'OR') && prop.value.type === 'ArrayExpression') {
      if (prop.value.elements.some(e => objectHasGuildIdKey(e))) return true;
    }
  }
  return false;
}

function callTargetsScopedModel(callee, scopedModels) {
  // callee = MemberExpression: prisma.<model>.<method>
  if (callee.type !== 'MemberExpression') return null;
  const method = callee.property.name;
  if (!QUERY_METHODS.has(method)) return null;
  const modelExpr = callee.object;
  if (modelExpr.type !== 'MemberExpression') return null;
  const modelName = modelExpr.property.name;
  if (!scopedModels.has(modelName)) return null;
  const root = modelExpr.object;
  // Akzeptiere Identifier `prisma`, `tx`, `_tx`, `_prisma` (Transactions)
  if (root.type !== 'Identifier') return null;
  if (!/^_?(prisma|tx|trx)\b/i.test(root.name)) return null;
  return { modelName, method };
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Verbietet Prisma-Queries auf scoped Models ohne guildId im where',
    },
    messages: {
      missingGuildId:
        'prisma.{{model}}.{{method}}() ohne `guildId` im where — Cross-Guild-Leak moeglich.',
      missingArg:
        'prisma.{{model}}.{{method}}() ohne Argument — Scope kann nicht geprueft werden.',
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
        if (arg.type !== 'ObjectExpression') return; // dynamische Args — nicht statisch pruefbar
        const whereProp = arg.properties.find(
          p => p.type === 'Property' && !p.computed
            && (p.key.name === 'where' || p.key.value === 'where'),
        );
        // create/createMany haben kein where — ueberspringen
        if (!whereProp) {
          if (target.method.startsWith('find') || target.method === 'count' || target.method.startsWith('update')
              || target.method.startsWith('delete') || target.method === 'aggregate' || target.method === 'groupBy') {
            // diese Methoden brauchen where (oder es ist ein gewollter "alle" -> disable)
            context.report({ node, messageId: 'missingGuildId', data: reportData });
          }
          return;
        }
        if (!objectHasGuildIdKey(whereProp.value)) {
          context.report({ node, messageId: 'missingGuildId', data: reportData });
        }
      },
    };
  },
};
