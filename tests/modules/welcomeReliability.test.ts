import path from 'node:path';

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: { botConfig: { findUnique: jest.fn(), upsert: jest.fn() } },
}));

jest.mock('../../src/config', () => ({
  config: { upload: { dir: '/srv/vbot-data/uploads' } },
}));

jest.mock('../../src/utils/safeSend', () => ({ safeSend: jest.fn() }));

import {
  renderWelcomeMessage,
  resolveWelcomeMediaSource,
} from '../../src/modules/welcome/welcomeManager';

describe('Welcome reliability', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('renders date and calendar parts from the same Europe/Berlin day across the UTC year boundary', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-12-31T23:30:00.000Z'));

    const rendered = renderWelcomeMessage(
      '{date}|{time}|{year}|{month}|{day}|{user}|{mention}|{guild}|{count}',
      {
        user: '<@111111111111111111>',
        mention: '<@111111111111111111>',
        guild: 'Test Guild',
        memberCount: 42,
      },
    );

    expect(rendered).toContain('1. Januar 2027');
    expect(rendered).toContain('|2027|1|1|');
    expect(rendered).toContain('<@111111111111111111>|<@111111111111111111>|Test Guild|42');
  });

  it('maps /uploads URLs into the configured upload root instead of process.cwd()', () => {
    expect(resolveWelcomeMediaSource('/uploads/media/welcome/123/image.png')).toBe(
      path.resolve('/srv/vbot-data/uploads/media/welcome/123/image.png'),
    );
  });

  it('rejects a local upload path that escapes the configured upload root', () => {
    expect(() => resolveWelcomeMediaSource('/uploads/../private/secret.png'))
      .toThrow(/Ungueltiger lokaler Willkommensmedien-Pfad/);
  });

  it('leaves external media URLs unchanged', () => {
    const url = 'https://cdn.example.test/welcome.gif';
    expect(resolveWelcomeMediaSource(url)).toBe(url);
  });
});
