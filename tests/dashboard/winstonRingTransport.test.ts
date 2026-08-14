import { logger } from '../../src/utils/logger';
import {
  __resetObservabilityForTests,
  attachLogRingBuffer,
  queryLogRing,
} from '../../src/dashboard/services/observability';

describe('Winston DEV ring transport', () => {
  beforeEach(() => {
    __resetObservabilityForTests();
  });

  it('wird ohne LegacyTransport-Warnung angebunden und empfaengt Logs', done => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    attachLogRingBuffer(logger);
    logger.info('ring-modern-transport-regression', { source: 'jest' });

    setImmediate(() => {
      const combined = [
        ...errorSpy.mock.calls.flat().map(String),
        ...warnSpy.mock.calls.flat().map(String),
      ].join(' ');
      expect(combined).not.toContain('legacy winston transport');
      expect(queryLogRing({ q: 'ring-modern-transport-regression', limit: 10 }))
        .toEqual(expect.arrayContaining([
          expect.objectContaining({ message: 'ring-modern-transport-regression' }),
        ]));
      errorSpy.mockRestore();
      warnSpy.mockRestore();
      done();
    });
  });
});
