import {
  containsPosition,
  createCircleGeometry,
  createPolygonGeometry,
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

  it('lehnt selbstüberschneidende und kartenüberschreitende Geometrien ab', () => {
    const bowTie = [{ x: 0, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }, { x: 100, y: 0 }];
    expect(polygonSelfIntersects(bowTie)).toBe(true);
    expect(createPolygonGeometry(bowTie)).toBeNull();
    const circle = createCircleGeometry(10, 10, 20);
    expect(geometryFitsMap('LIVONIA', circle!)).toBe(false);
  });
});