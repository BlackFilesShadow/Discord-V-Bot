// ESLint v9 Flat-Config (Paket 3 – DX).
// Fokus: floating-promises, unused vars, security gotchas – ohne dass die
// bestehenden Commands zu hunderten neuen Warnings fuehren.

import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import noUnscopedPrismaQuery from './eslint-rules/no-unscoped-prisma-query.js';

const localRules = {
  rules: {
    'no-unscoped-prisma-query': noUnscopedPrismaQuery,
  },
};

export default [
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'coverage/**',
      'logs/**',
      'uploads/**',
      'prisma/migrations/**',
      'deploy/**',
      'src/dashboard/public/**',
      'dashboard-ui/**',
      '*.js',
      'jest.config.js',
    ],
  },
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
      'local': localRules,
    },
    rules: {
      '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: true }],
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: false }],
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
      // DB-1 Scope-Matrix: ALLE aus schema.prisma abgeleiteten Models mit
      // direktem guildId sind jetzt harter Mandantenschutz. Die fruehere
      // strict/extras-Aufteilung mit Advisory-Warnungen ist damit beendet.
      // Bewusste globale Aggregationen muessen lokal und begruendet disabled
      // werden; stillschweigende Cross-Guild-Queries sind nicht mehr erlaubt.
      'local/no-unscoped-prisma-query': ['error', { set: 'all' }],
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'prefer-const': 'warn',
      'no-var': 'error',
    },
  },
  {
    // Stage 65: these global/admin/system modules intentionally cross tenant
    // boundaries after authZ or operate on system-wide data. Stage 64 originally
    // documented that fact with file-local disables; the UTF-8 repair restores
    // their pre-corruption source blobs, so the same narrow exception lives here.
    files: [
      'src/dashboard/routes/v2/botAdmin.ts',
      'src/dashboard/routes/v2/botAdminCommandCenter.ts',
      'src/dashboard/routes/v2/devCommandCenter.ts',
      'src/dashboard/routes/v2/devSecureExport.ts',
      'src/modules/ai/translatedPostSchedulerV2.ts',
      'src/modules/logging/analyticsManager.ts',
      'src/modules/logging/auditRetentionScheduler.ts',
      'src/modules/reminders/reminderScheduler.ts',
    ],
    rules: {
      'local/no-unscoped-prisma-query': 'off',
    },
  },
  {
    files: ['tests/**/*.ts', 'src/**/__tests__/**/*.ts', 'scripts/**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        project: './tsconfig.test.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/no-misused-promises': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
    },
  },
];
