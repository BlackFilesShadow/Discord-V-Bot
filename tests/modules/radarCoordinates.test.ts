import {
  RADAR_MAP_CALIBRATIONS,
  dayzIzurviveUrl,
  dayzToMapLibre,
  isPositionInsideMap,
  mapLibreToDayz,
  parseAdmDayzPosition,
  parseAdmTerritoryFlagPosition,
  type RadarMap,
} from '../../src/shared/radarCoordinates';

describe('Radar-Koordinatenkern', () => {
  it('normalisiert normale ADM-X-Z-Hoehe-Vektoren in Radar-Koordinaten', () => {
    expect(parseAdmDayzPosition('<4769.7, 9525.0, 340.4>')).toEqual({
      x: 4769.7,
      y: 9525,
      altitude: 340.4,
    });
    expect(parseAdmDayzPosition('9805.7, 11606, 258.4')).toEqual({
      x: 9805.7,
      y: 11606,
      altitude: 258.4,
    });
    expect(parseAdmDayzPosition('1,2')).toBeNull();
    expect(parseAdmDayzPosition('1,invalid,3')).toBeNull();
  });

  it('normalisiert TerritoryFlag-X-Hoehe-Z separat und vertauscht niemals Z mit Hoehe', () => {
    expect(parseAdmTerritoryFlagPosition('<4643.467773, 339.000000, 10338.107422>')).toEqual({
      x: 4643.467773,
      y: 10338.107422,
      altitude: 339,
    });
    expect(parseAdmDayzPosition('<4643.467773, 339.000000, 10338.107422>')).toEqual({
      x: 4643.467773,
      y: 339,
      altitude: 10338.107422,
    });
  });

  it('haelt DayZ-X/Z und MapLibre innerhalb derselben Kartenbegrenzung invertierbar', () => {
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

  it.each(Object.keys(RADAR_MAP_CALIBRATIONS) as RadarMap[])('erhaelt X/Z fuer jeden Kartenrand und Innenpunkt exakt: %s', map => {
    const { widthMeters, heightMeters } = RADAR_MAP_CALIBRATIONS[map];
    const points = [
      { x: 0, y: 0 },
      { x: widthMeters, y: 0 },
      { x: 0, y: heightMeters },
      { x: widthMeters, y: heightMeters },
      { x: widthMeters * 0.137, y: heightMeters * 0.863 },
      { x: widthMeters / 2, y: heightMeters / 2 },
    ];

    for (const point of points) {
      const [longitude, latitude] = dayzToMapLibre(map, point);
      const restored = mapLibreToDayz(map, longitude, latitude);
      expect(restored).not.toBeNull();
      expect(restored?.x).toBeCloseTo(point.x, 6);
      expect(restored?.y).toBeCloseTo(point.y, 6);
      expect(restored?.altitude).toBeNull();
    }
  });

  it('erzeugt ausschliesslich map-aware iZurvive-Links aus gueltigen X/Z-Koordinaten', () => {
    expect(dayzIzurviveUrl('LIVONIA', { x: 4000, y: 5000 }))
      .toBe('https://www.izurvive.com/livonia/#location=4000;5000;6');
    expect(dayzIzurviveUrl('SAKHAL', { x: -1, y: 1 })).toBeNull();
  });
});
