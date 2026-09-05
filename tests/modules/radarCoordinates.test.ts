import {
  dayzIzurviveUrl,
  dayzToMapLibre,
  isPositionInsideMap,
  mapLibreToDayz,
  parseAdmDayzPosition,
} from '../../src/shared/radarCoordinates';

describe('Radar-Koordinatenkern', () => {
  it('normalisiert native ADM-X-Hoehe-Z-Vektoren in horizontale x/y-Koordinaten', () => {
    expect(parseAdmDayzPosition('<9662.8, 294.2, 8788.5>')).toEqual({
      x: 9662.8,
      y: 8788.5,
      altitude: 294.2,
    });
    expect(parseAdmDayzPosition('1,2')).toBeNull();
    expect(parseAdmDayzPosition('1,invalid,3')).toBeNull();
  });

  it('haelt DayZ- und MapLibre-Koordinaten innerhalb derselben Kartenbegrenzung invertierbar', () => {
    const position = { x: 4382.517, y: 10216.422 };
    const [longitude, latitude] = dayzToMapLibre('CHERNARUS', position);
    const restored = mapLibreToDayz('CHERNARUS', longitude, latitude);

    expect(restored).not.toBeNull();
    expect(restored?.x).toBeCloseTo(position.x, 6);
    expect(restored?.y).toBeCloseTo(position.y, 6);
    expect(restored?.altitude).toBeNull();
    expect(isPositionInsideMap('LIVONIA', { x: 12800, y: 12800 })).toBe(true);
    expect(isPositionInsideMap('LIVONIA', { x: 12800.01, y: 12800 })).toBe(false);
  });

  it('erzeugt ausschliesslich map-aware iZurvive-Links innerhalb der Kartenbegrenzung', () => {
    expect(dayzIzurviveUrl('LIVONIA', { x: 4000, y: 5000 }))
      .toBe('https://www.izurvive.com/livonia/#location=4000;5000;6');
    expect(dayzIzurviveUrl('SAKHAL', { x: -1, y: 1 })).toBeNull();
  });
});