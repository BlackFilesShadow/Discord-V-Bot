module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  // Live-E2E-Suite ist opt-in (siehe tests/e2e-live/README.md) und darf den
  // normalen Jest-Run sowie CI nie betreten — sie braucht echten Bot-Token,
  // Live-DB und Test-Guild.
  testPathIgnorePatterns: ['/node_modules/', '/tests/e2e-live/'],
  moduleNameMapper: {
    '^@utils/(.*)$': '<rootDir>/src/utils/$1',
    '^@modules/(.*)$': '<rootDir>/src/modules/$1',
    '^@commands/(.*)$': '<rootDir>/src/commands/$1',
    '^@events/(.*)$': '<rootDir>/src/events/$1',
    '^@middleware/(.*)$': '<rootDir>/src/middleware/$1',
    '^@dashboard/(.*)$': '<rootDir>/src/dashboard/$1',
    '^@database/(.*)$': '<rootDir>/src/database/$1',
    '^@types/(.*)$': '<rootDir>/src/types/$1',
  },
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.test.json' }],
  },
  coverageDirectory: 'coverage',
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts'],
  // Ratchet-Floor: knapp unter Ist-Coverage (Stand 2026-05). Verhindert
  // Regression bei jedem PR mit `--coverage`. Schwelle wird angehoben
  // wenn neue Tests grosse Module abdecken (siehe CONTRIBUTING.md).
  // Stand jest: statements 15.7%, branches ~5%, functions ~26%, lines ~15.7%.
  coverageThreshold: {
    global: {
      statements: 14,
      branches: 4,
      functions: 24,
      lines: 14,
    },
  },
};
