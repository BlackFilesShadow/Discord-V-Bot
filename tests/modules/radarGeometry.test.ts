import {
  altitudeContains,
  altitudeContainsWithMargin,
  containsPosition,
  containsPositionWithMargin,
  createCircleGeometry,
  createPolygonGeometry,
  distanceInsideBoundary,
  geometryFitsMap,
  polygonSelfIntersects,
} from '../../src/modules/radar/geometry';

describe('Radar-Zonengeometrie', () => {
  it('behandelt den Kreisrand als innerhalb und verwirft ungueltige Radien', () => {
    const circle = createCircleGeometry(100, 200, 50);
    expect(circle).not.toBeNull();
    expect(containsPosition(circle!, { x: 150, y: 200 })).toBe(true);
    expect(containsPosition(circle!, { x: 150.001, y: 200 })).toBe(false);
    expect(createCircleGeometry(1, 2, 0)).toBeNull();
  });

  it('behandelt Polygonränder als innerhalb und bewahrt die Punktreihenfolge', () => {
    const points = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
    const polygon = createPolygonGeometry(points);
    expect(polygon?.points).toEqual(points);
    expect(containsPosition(polygon!, { x: 50, y: 0 })).toBe(true);
    expect(containsPosition(polygon!, { x: 50, y: 50 })).toBe(true);
    expect(containsPosition(polygon!, { x: 101, y: 50 })).toBe(false);
  });

  it('trennt Radar-Erkennung vom 10m-Sicherheitsrand fuer punitive Entscheidungen', () => {
    const circle = createCircleGeometry(100, 100, 50)!;
    expect(containsPosition(circle, { x: 149, y: 100 })).toBe(true);
    expect(distanceInsideBoundary(circle, { x: 149, y: 100 })).toBeCloseTo(1);
    expect(containsPositionWithMargin(circle, { x: 149, y: 100 }, 10)).toBe(false);
    expect(containsPositionWithMargin(circle, { x: 140, y: 100 }, 10)).toBe(true);

    const polygon = createPolygonGeometry([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }])!;
    expect(containsPosition(polygon, { x: 5, y: 50 })).toBe(true);
    expect(containsPositionWithMargin(polygon, { x: 5, y: 50 }, 10)).toBe(false);
    expect(containsPositionWithMargin(polygon, { x: 50, y: 50 }, 10)).toBe(true);
    expect(containsPositionWithMargin(polygon, { x: 50, y: 0 }, 10)).toBe(false);
  });

  it('wertet optionale ADM-Hoehenbaender fail-closed und mit vertikalem Sicherheitsrand aus', () => {
    const off = { enabled: false, minAltitudeMeters: null, maxAltitudeMeters: null };
    expect(altitudeContains(off, null)).toBe(true);
    expect(altitudeContainsWithMargin(off, null, 10)).toBe(true);

    const range = { enabled: true, minAltitudeMeters: 100, maxAltitudeMeters: 200 };
    expect(altitudeContains(range, 100)).toBe(true);
    expect(altitudeContains(range, 150)).toBe(true);
    expect(altitudeContains(range, 200)).toBe(true);
    expect(altitudeContains(range, 99.9)).toBe(false);
    expect(altitudeContains(range, null)).toBe(false);
    expect(altitudeContainsWithMargin(range, 105, 10)).toBe(false);
    expect(altitudeContainsWithMargin(range, 110, 10)).toBe(true);
    expect(altitudeContainsWithMargin(range, 190, 10)).toBe(true);
    expect(altitudeContainsWithMargin(range, 195, 10)).toBe(false);
  });

  it('lehnt selbstüberschneidende und kartenüberschreitende Geometrien ab', () => {
    const bowTie = [{ x: 0, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }, { x: 100, y: 0 }];
    expect(polygonSelfIntersects(bowTie)).toBe(true);
    expect(createPolygonGeometry(bowTie)).toBeNull();
    const circle = createCircleGeometry(10, 10, 20);
    expect(geometryFitsMap('LIVONIA', circle!)).toBe(false);
  });
});
