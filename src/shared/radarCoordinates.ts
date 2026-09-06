export type RadarMap = 'CHERNARUS' | 'LIVONIA' | 'SAKHAL';

export interface DayzPosition {
  /** Horizontal DayZ world coordinate X. */
  x: number;
  /** Horizontal DayZ world coordinate Z. Kept as `y` internally for the existing 2D geometry API. */
  y: number;
  /** ADM terrain/vertical component. Never exposed as a user-facing radar coordinate. */
  altitude: number | null;
}

export interface RadarMapCalibration {
  map: RadarMap;
  label: string;
  widthMeters: number;
  heightMeters: number;
  basemapRevision: string;
  terrainAvailable: boolean;
}

export const RADAR_MAP_CALIBRATIONS: Record<RadarMap, RadarMapCalibration> = {
  CHERNARUS: {
    map: 'CHERNARUS',
    label: 'Chernarus',
    widthMeters: 15360,
    heightMeters: 15360,
    basemapRevision: '9a21bb9f5fb9c62a7ce2761402196091588133e6',
    terrainAvailable: false,
  },
  LIVONIA: {
    map: 'LIVONIA',
    label: 'Livonia',
    widthMeters: 12800,
    heightMeters: 12800,
    basemapRevision: '9a21bb9f5fb9c62a7ce2761402196091588133e6',
    terrainAvailable: false,
  },
  SAKHAL: {
    map: 'SAKHAL',
    label: 'Sakhal',
    widthMeters: 15360,
    heightMeters: 15360,
    basemapRevision: '9a21bb9f5fb9c62a7ce2761402196091588133e6',
    terrainAvailable: false,
  },
};

const IZURVIVE_BASE_URL: Record<RadarMap, string> = {
  CHERNARUS: 'https://www.izurvive.com/chernarusplus/',
  LIVONIA: 'https://www.izurvive.com/livonia/',
  SAKHAL: 'https://www.izurvive.com/sakhal/',
};

const EARTH_RADIUS = 6378137;
const COORDINATE_EPSILON = 1e-7;

function finite(value: number): boolean {
  return Number.isFinite(value);
}

function coordinateTriplet(raw: string | null | undefined): readonly [number, number, number] | null {
  if (!raw) return null;
  const values = raw.replace(/[<>]/g, '').split(',').map(part => Number(part.trim()));
  if (values.length !== 3 || values.some(value => !finite(value))) return null;
  return [values[0], values[1], values[2]];
}

/**
 * Normal DayZ console ADM positions are emitted as X, Z, altitude.
 * Radar keeps X/Z as the only horizontal/user-facing coordinates and retains
 * the third value solely as internal evidence for precise event matching.
 */
export function parseAdmDayzPosition(raw: string | null | undefined): DayzPosition | null {
  const values = coordinateTriplet(raw);
  return values ? { x: values[0], y: values[1], altitude: values[2] } : null;
}

/**
 * TerritoryFlag action logs use the engine vector order X, altitude, Z for the
 * `... on TerritoryFlag at <...>` target, unlike the player's X,Z,altitude
 * vector in the same ADM line. This parser is deliberately separate so the
 * two formats can never be silently interchanged.
 */
export function parseAdmTerritoryFlagPosition(raw: string | null | undefined): DayzPosition | null {
  const values = coordinateTriplet(raw);
  return values ? { x: values[0], y: values[2], altitude: values[1] } : null;
}

export function isPositionInsideMap(map: RadarMap, position: Pick<DayzPosition, 'x' | 'y'>): boolean {
  const calibration = RADAR_MAP_CALIBRATIONS[map];
  return finite(position.x)
    && finite(position.y)
    && position.x >= 0
    && position.x <= calibration.widthMeters
    && position.y >= 0
    && position.y <= calibration.heightMeters;
}

export function dayzToMapLibre(map: RadarMap, position: Pick<DayzPosition, 'x' | 'y'>): readonly [number, number] {
  const calibration = RADAR_MAP_CALIBRATIONS[map];
  const mercatorX = position.x - calibration.widthMeters / 2;
  const mercatorY = calibration.heightMeters / 2 - position.y;
  const longitude = (mercatorX / EARTH_RADIUS) * (180 / Math.PI);
  const latitude = Math.atan(Math.sinh(mercatorY / EARTH_RADIUS)) * (180 / Math.PI);
  return [longitude, latitude];
}

export function mapLibreToDayz(map: RadarMap, longitude: number, latitude: number): DayzPosition | null {
  if (!finite(longitude) || !finite(latitude) || Math.abs(latitude) >= 90) return null;
  const calibration = RADAR_MAP_CALIBRATIONS[map];
  const mercatorX = EARTH_RADIUS * longitude * Math.PI / 180;
  const mercatorY = EARTH_RADIUS * Math.log(Math.tan(Math.PI / 4 + (latitude * Math.PI / 180) / 2));
  const x = mercatorX + calibration.widthMeters / 2;
  const y = calibration.heightMeters / 2 - mercatorY;
  const position = {
    x: Math.abs(x) <= COORDINATE_EPSILON ? 0 : Math.abs(x - calibration.widthMeters) <= COORDINATE_EPSILON ? calibration.widthMeters : x,
    y: Math.abs(y) <= COORDINATE_EPSILON ? 0 : Math.abs(y - calibration.heightMeters) <= COORDINATE_EPSILON ? calibration.heightMeters : y,
    altitude: null,
  };
  return isPositionInsideMap(map, position) ? position : null;
}

export function dayzIzurviveUrl(map: RadarMap, position: Pick<DayzPosition, 'x' | 'y'>, zoom = 6): string | null {
  if (!isPositionInsideMap(map, position) || !Number.isInteger(zoom) || zoom < 0 || zoom > 20) return null;
  return `${IZURVIVE_BASE_URL[map]}#location=${position.x};${position.y};${zoom}`;
}
