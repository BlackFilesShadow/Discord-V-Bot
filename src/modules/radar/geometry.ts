import type { RadarMap } from '../../shared/radarCoordinates';
import { isPositionInsideMap } from '../../shared/radarCoordinates';

export interface RadarPoint {
  x: number;
  y: number;
}

export interface RadarBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface CircleGeometry extends RadarBounds {
  shape: 'CIRCLE';
  centerX: number;
  centerY: number;
  radiusMeters: number;
}

export interface PolygonGeometry extends RadarBounds {
  shape: 'POLYGON';
  points: readonly RadarPoint[];
}

export type RadarGeometry = CircleGeometry | PolygonGeometry;

const EPSILON = 1e-9;

function finitePoint(point: RadarPoint): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y);
}

function pointsEqual(a: RadarPoint, b: RadarPoint): boolean {
  return Math.abs(a.x - b.x) <= EPSILON && Math.abs(a.y - b.y) <= EPSILON;
}

function cross(a: RadarPoint, b: RadarPoint, point: RadarPoint): number {
  return (b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x);
}

function pointOnSegment(point: RadarPoint, start: RadarPoint, end: RadarPoint): boolean {
  return Math.abs(cross(start, end, point)) <= EPSILON
    && point.x >= Math.min(start.x, end.x) - EPSILON
    && point.x <= Math.max(start.x, end.x) + EPSILON
    && point.y >= Math.min(start.y, end.y) - EPSILON
    && point.y <= Math.max(start.y, end.y) + EPSILON;
}

function orientation(a: RadarPoint, b: RadarPoint, c: RadarPoint): number {
  const value = cross(a, b, c);
  return Math.abs(value) <= EPSILON ? 0 : value > 0 ? 1 : -1;
}

function segmentsIntersect(a: RadarPoint, b: RadarPoint, c: RadarPoint, d: RadarPoint): boolean {
  const abC = orientation(a, b, c);
  const abD = orientation(a, b, d);
  const cdA = orientation(c, d, a);
  const cdB = orientation(c, d, b);
  if (abC !== abD && cdA !== cdB) return true;
  return (abC === 0 && pointOnSegment(c, a, b))
    || (abD === 0 && pointOnSegment(d, a, b))
    || (cdA === 0 && pointOnSegment(a, c, d))
    || (cdB === 0 && pointOnSegment(b, c, d));
}

export function boundsForPoints(points: readonly RadarPoint[]): RadarBounds | null {
  if (points.length === 0 || points.some(point => !finitePoint(point))) return null;
  return points.reduce<RadarBounds>((bounds, point) => ({
    minX: Math.min(bounds.minX, point.x),
    minY: Math.min(bounds.minY, point.y),
    maxX: Math.max(bounds.maxX, point.x),
    maxY: Math.max(bounds.maxY, point.y),
  }), { minX: points[0].x, minY: points[0].y, maxX: points[0].x, maxY: points[0].y });
}

export function createCircleGeometry(centerX: number, centerY: number, radiusMeters: number): CircleGeometry | null {
  if (![centerX, centerY, radiusMeters].every(Number.isFinite) || radiusMeters <= 0) return null;
  return {
    shape: 'CIRCLE',
    centerX,
    centerY,
    radiusMeters,
    minX: centerX - radiusMeters,
    minY: centerY - radiusMeters,
    maxX: centerX + radiusMeters,
    maxY: centerY + radiusMeters,
  };
}

export function polygonSelfIntersects(points: readonly RadarPoint[]): boolean {
  if (points.length < 3) return false;
  for (let index = 0; index < points.length; index += 1) {
    const nextIndex = (index + 1) % points.length;
    for (let otherIndex = index + 1; otherIndex < points.length; otherIndex += 1) {
      const otherNextIndex = (otherIndex + 1) % points.length;
      if (index === otherIndex || nextIndex === otherIndex || otherNextIndex === index) continue;
      if (segmentsIntersect(points[index], points[nextIndex], points[otherIndex], points[otherNextIndex])) return true;
    }
  }
  return false;
}

export function createPolygonGeometry(points: readonly RadarPoint[]): PolygonGeometry | null {
  const unique = new Set(points.map(point => `${point.x}:${point.y}`));
  const bounds = boundsForPoints(points);
  if (points.length < 3 || unique.size < 3 || !bounds || polygonSelfIntersects(points)) return null;
  return { shape: 'POLYGON', points: [...points], ...bounds };
}

export function boundsContainPosition(bounds: RadarBounds, point: RadarPoint): boolean {
  return point.x >= bounds.minX && point.x <= bounds.maxX && point.y >= bounds.minY && point.y <= bounds.maxY;
}

export function containsPosition(geometry: RadarGeometry, point: RadarPoint): boolean {
  if (!boundsContainPosition(geometry, point)) return false;
  if (geometry.shape === 'CIRCLE') {
    const dx = point.x - geometry.centerX;
    const dy = point.y - geometry.centerY;
    return dx * dx + dy * dy <= geometry.radiusMeters * geometry.radiusMeters + EPSILON;
  }

  let inside = false;
  for (let index = 0, previous = geometry.points.length - 1; index < geometry.points.length; previous = index, index += 1) {
    const current = geometry.points[index];
    const prior = geometry.points[previous];
    if (pointOnSegment(point, prior, current)) return true;
    const crosses = (current.y > point.y) !== (prior.y > point.y);
    const xAtY = ((prior.x - current.x) * (point.y - current.y)) / (prior.y - current.y) + current.x;
    if (crosses && point.x < xAtY) inside = !inside;
  }
  return inside;
}

export function geometryFitsMap(map: RadarMap, geometry: RadarGeometry): boolean {
  if (geometry.shape === 'CIRCLE') {
    return isPositionInsideMap(map, { x: geometry.minX, y: geometry.minY })
      && isPositionInsideMap(map, { x: geometry.maxX, y: geometry.maxY });
  }
  return geometry.points.every(point => isPositionInsideMap(map, point));
}