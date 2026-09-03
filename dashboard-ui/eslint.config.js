// ESLint 9 Flat-Config fuer das Dashboard-UI (React + TypeScript).
// Bewusst schlank gehalten: typescript-eslint Recommended + React-Hooks-Regeln.
// Aufruf via `npm run lint` (kein --ext mehr noetig — Flat-Config nutzt Globs).
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: ['dist', 'node_modules', 'playwright-report', 'test-results'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  {
    // Diese Module exportieren bewusst jeweils Provider und zugehoerigen Hook.
    // Eine Aufteilung wuerde die Context-Implementierung lediglich strecken.
    files: [
      'src/components/ui/Toast.tsx',
      'src/lib/auth.tsx',
      'src/lib/botAdminSession.tsx',
      'src/lib/density.tsx',
      'src/lib/devSession.tsx',
      'src/lib/pinnedTools.tsx',
      'src/lib/recentActions.tsx',
      'src/lib/theme.tsx',
      'src/lib/toast.tsx',
    ],
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },
);
