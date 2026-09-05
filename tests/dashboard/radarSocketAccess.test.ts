import { radarPermissionAllows, serverFeedPermissionAllows } from '../../src/dashboard/socket/guild';
import { radarRoomName } from '../../src/dashboard/socket/emitter';

describe('Radar Socket Access', () => {
  it('isoliert Radar- und Killfeed-Berechtigungen', () => {
    expect(radarPermissionAllows(false, ['radar.view'])).toBe(true);
    expect(radarPermissionAllows(false, ['killfeed.view'])).toBe(false);
    expect(serverFeedPermissionAllows(false, ['radar.view'])).toBe(false);
    expect(radarPermissionAllows(true, [])).toBe(true);
  });

  it('bildet strikt servergebundene Radar-Räume', () => {
    expect(radarRoomName('123456789012345678', 'c123456789012345678901234')).toBe('gr:123456789012345678:c123456789012345678901234');
  });
});