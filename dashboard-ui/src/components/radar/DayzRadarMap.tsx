import { useEffect, useRef, useState } from 'react';
import * as maplibregl from 'maplibre-gl';
import { type GeoJSONSource, type Map as MapLibreMap } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { dayzToMapLibre, isPositionInsideMap, mapLibreToDayz, RADAR_MAP_CALIBRATIONS, type RadarMap } from '@radar-coordinates';

type Point = { x: number; y: number };
export interface MapZone {
  id: string;
  name: string;
  isActive: boolean;
  geometry: { type: 'CIRCLE'; x: number; y: number; radiusMeters: number } | { type: 'POLYGON'; points: Point[] };
}

function circlePoints(map: RadarMap, x: number, y: number, radiusMeters: number): number[][] {
  return Array.from({ length: 49 }, (_, index) => {
    const radians = (index / 48) * Math.PI * 2;
    const [longitude, latitude] = dayzToMapLibre(map, { x: x + Math.cos(radians) * radiusMeters, y: y + Math.sin(radians) * radiusMeters });
    return [longitude, latitude];
  });
}

function featureCollection(map: RadarMap, zones: MapZone[]) {
  return {
    type: 'FeatureCollection' as const,
    features: zones.filter(zone => zone.geometry.type === 'CIRCLE' || zone.geometry.points.length >= 3).map(zone => ({
      type: 'Feature' as const,
      properties: { id: zone.id, name: zone.name, active: zone.isActive },
      geometry: zone.geometry.type === 'CIRCLE'
        ? { type: 'Polygon' as const, coordinates: [circlePoints(map, zone.geometry.x, zone.geometry.y, zone.geometry.radiusMeters)] }
        : { type: 'Polygon' as const, coordinates: [[...zone.geometry.points.map(point => dayzToMapLibre(map, point)), dayzToMapLibre(map, zone.geometry.points[0])]] },
    })),
  };
}

export function DayzRadarMap({ activeMap, zones, onMapClick }: { activeMap: RadarMap; zones: MapZone[]; onMapClick?: (point: Point) => void }) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const zonesRef = useRef(zones);
  const onMapClickRef = useRef(onMapClick);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { zonesRef.current = zones; }, [zones]);
  useEffect(() => { onMapClickRef.current = onMapClick; }, [onMapClick]);

  useEffect(() => {
    const calibration = RADAR_MAP_CALIBRATIONS[activeMap];
    const northWest = [...dayzToMapLibre(activeMap, { x: 0, y: 0 })] as [number, number];
    const southEast = [...dayzToMapLibre(activeMap, { x: calibration.widthMeters, y: calibration.heightMeters })] as [number, number];
    const southWest: [number, number] = [northWest[0], southEast[1]];
    const northEast: [number, number] = [southEast[0], northWest[1]];
    const map = new maplibregl.Map({ container: container.current!, style: { version: 8, sources: {}, layers: [] }, center: [0, 0], zoom: 10, maxBounds: [southWest, northEast], attributionControl: { compact: true } });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ showCompass: true }), 'top-right');
    map.on('error', (event: maplibregl.ErrorEvent) => setError(event.error?.message ?? 'Die lokale Radar-Basemap konnte nicht geladen werden.'));
    map.on('load', () => {
      map.addSource('basemap', { type: 'image', url: `/radar/maps/${activeMap.toLowerCase()}.png`, coordinates: [northWest, [southEast[0], northWest[1]], southEast, [northWest[0], southEast[1]]] });
      map.addLayer({ id: 'basemap', type: 'raster', source: 'basemap' });
      map.addSource('zones', { type: 'geojson', data: featureCollection(activeMap, zonesRef.current) });
      map.addLayer({ id: 'zone-fill', type: 'fill', source: 'zones', paint: { 'fill-color': ['case', ['get', 'active'], '#ef4444', '#94a3b8'], 'fill-opacity': 0.2 } });
      map.addLayer({ id: 'zone-line', type: 'line', source: 'zones', paint: { 'line-color': ['case', ['get', 'active'], '#ef4444', '#94a3b8'], 'line-width': 2 } });
      map.on('click', event => {
        const point = mapLibreToDayz(activeMap, event.lngLat.lng, event.lngLat.lat);
        if (point && isPositionInsideMap(activeMap, point)) onMapClickRef.current?.(point);
      });
      map.fitBounds([northWest, southEast], { padding: 24, duration: 0 });
    });
    return () => { mapRef.current = null; map.remove(); };
  }, [activeMap]);

  useEffect(() => {
    const source = mapRef.current?.getSource('zones') as GeoJSONSource | undefined;
    source?.setData(featureCollection(activeMap, zones));
  }, [activeMap, zones]);

  return <div className="relative h-[28rem] overflow-hidden border border-border/70"><div ref={container} className={`h-full w-full ${onMapClick ? 'cursor-crosshair' : ''}`} aria-label="DayZ Radar-Karte" /><p className="pointer-events-none absolute bottom-1 right-1 bg-bg/85 px-1.5 py-0.5 text-[10px] text-muted">DayZ Central Economy · ADPL-SA</p>{error && <p role="alert" className="absolute inset-x-3 bottom-3 bg-bg/95 p-2 text-sm text-danger">{error}</p>}</div>;
}