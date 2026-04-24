// ESLint v9 Flat-Config (Paket 3 \u2013 DX).
// Fokus: floating-promises, unused vars, security gotchas \u2013 ohne dass die
// bestehenden 46 Commands zu hunderten neuen Warnings fuehren. Strict-Modus
// (no-explicit-any, strict-boolean-expressions) wird bewusst NICHT aktiviert,
// weil das im Bestand zu viel Noise erzeugt; wir starten konservativ und
// koennen nach und nach verschaerfen.

import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';

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
    },
    rules: {
      // Sicherheit / Stabilitaet \u2013 hier schlaegt ESLint die Bugs der Audit
      // (silente Floating-Promises) tatsaechlich raus.
      '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: true }],
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: false }],
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
      // Codequalitaet \u2013 erlaubt aber hinterlaesst gelben Hint
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'prefer-const': 'warn',
      'no-var': 'error',
    },
  },
  {
    // Tests duerfen lockerer sein.
    files: ['tests/**/*.ts', 'src/**/__tests__/**/*.ts'],
    rules: {
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/no-misused-promises': 'off',
    },
  },
];
