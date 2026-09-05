import { useEffect, useRef, useState } from 'react';
import * as maplibregl from 'maplibre-gl';
import { type GeoJSONSource, type Map as MapLibreMap } from 'maplibre-gl';
import type { Feature, FeatureCollection } from 'geojson';
import 'maplibre-gl/dist/maplibre-gl.css';
import { dayzToMapLibre, isPositionInsideMap, mapLibreToDayz, RADAR_MAP_CALIBRATIONS, type RadarMap } from '@radar-coordinates';

type Point = { x: number; y: number };
export interface MapZone {
  id: string;
  name: string;
  isActive: boolean;
  isDraft?: boolean;
  geometry: { type: 'CIRCLE'; x: number; y: number; radiusMeters: number } | { type: 'POLYGON'; points: Point[] };
}

function circlePoints(map: RadarMap, x: number, y: number, radiusMeters: number): number[][] {
  return Array.from({ length: 49 }, (_, index) => {
    const radians = (index / 48) * Math.PI * 2;
    const [longitude, latitude] = dayzToMapLibre(map, { x: x + Math.cos(radians) * radiusMeters, y: y + Math.sin(radians) * radiusMeters });
    return [longitude, latitude];
  });
}

function featureCollection(map: RadarMap, zones: MapZone[], previewPoint?: Point): FeatureCollection {
  const features: Feature[] = [];
  for (const zone of zones) {
    const properties = { id: zone.id, name: zone.name, active: zone.isActive, draft: zone.isDraft === true };
    if (zone.geometry.type === 'CIRCLE') {
      features.push({ type: 'Feature', properties, geometry: { type: 'Polygon', coordinates: [circlePoints(map, zone.geometry.x, zone.geometry.y, zone.geometry.radiusMeters)] } });
      features.push({ type: 'Feature', properties: { ...properties, center: true }, geometry: { type: 'Point', coordinates: [...dayzToMapLibre(map, zone.geometry)] } });
      continue;
    }
    const points = zone.geometry.points.map(point => [...dayzToMapLibre(map, point)]);
    features.push({
      type: 'Feature', properties,
      geometry: points.length >= 3
        ? { type: 'Polygon', coordinates: [[...points, points[0]]] }
        : points.length === 2
          ? { type: 'LineString', coordinates: points }
          : { type: 'Point', coordinates: points[0] ?? [0, 0] },
    });
    if (zone.isDraft && points.length > 0 && previewPoint) {
      const previewLine = [...points, [...dayzToMapLibre(map, previewPoint)]];
      if (previewLine.length >= 2) features.push({ type: 'Feature', properties: { ...properties, drawing: true }, geometry: { type: 'LineString', coordinates: previewLine } });
    }
    zone.geometry.points.forEach((point, index) => features.push({ type: 'Feature', properties: { ...properties, vertex: index + 1 }, geometry: { type: 'Point', coordinates: [...dayzToMapLibre(map, point)] } }));
  }
  return {
    type: 'FeatureCollection' as const,
    features,
  };
}

export function DayzRadarMap({ activeMap, zones, onMapClick, onMapMove, focusPoint, circleCenter, circleRadiusMode, onCircleRadiusChange, previewPoint }: { activeMap: RadarMap; zones: MapZone[]; onMapClick?: (point: Point) => void; onMapMove?: (point: Point) => void; focusPoint?: Point; circleCenter?: Point; circleRadiusMode?: boolean; onCircleRadiusChange?: (radiusMeters: number) => void; previewPoint?: Point }) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const zonesRef = useRef(zones);
  const onMapClickRef = useRef(onMapClick);
  const onMapMoveRef = useRef(onMapMove);
  const circleCenterRef = useRef(circleCenter);
  const circleRadiusModeRef = useRef(circleRadiusMode);
  const onCircleRadiusChangeRef = useRef(onCircleRadiusChange);
  const [mapReady, setMapReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { zonesRef.current = zones; }, [zones]);
  useEffect(() => { onMapClickRef.current = onMapClick; }, [onMapClick]);
  useEffect(() => { onMapMoveRef.current = onMapMove; }, [onMapMove]);
  useEffect(() => { circleCenterRef.current = circleCenter; }, [circleCenter]);
  useEffect(() => { circleRadiusModeRef.current = circleRadiusMode; }, [circleRadiusMode]);
  useEffect(() => { onCircleRadiusChangeRef.current = onCircleRadiusChange; }, [onCircleRadiusChange]);

  useEffect(() => {
    setMapReady(false);
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
      map.addSource('zones', { type: 'geojson', data: featureCollection(activeMap, zonesRef.current, previewPoint) });
      map.addLayer({ id: 'zone-fill', type: 'fill', source: 'zones', paint: { 'fill-color': '#ef4444', 'fill-opacity': ['case', ['get', 'draft'], 0.3, 0.22] } });
      map.addLayer({ id: 'zone-line', type: 'line', source: 'zones', paint: { 'line-color': '#dc2626', 'line-width': ['case', ['get', 'draft'], 4, 3] } });
      map.addLayer({ id: 'zone-vertices', type: 'circle', source: 'zones', filter: ['==', '$type', 'Point'], paint: { 'circle-radius': 9, 'circle-color': '#dc2626', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 3 } });
      map.on('click', event => {
        const point = mapLibreToDayz(activeMap, event.lngLat.lng, event.lngLat.lat);
        if (point && isPositionInsideMap(activeMap, point)) onMapClickRef.current?.(point);
      });
      let resizingCircle = false;
      let previewFrame: number | undefined;
      let queuedPreviewPoint: Point | undefined;
      const setCircleRadius = (event: maplibregl.MapMouseEvent) => {
        const center = circleCenterRef.current;
        const point = mapLibreToDayz(activeMap, event.lngLat.lng, event.lngLat.lat);
        if (center && point && isPositionInsideMap(activeMap, point)) onCircleRadiusChangeRef.current?.(Math.max(1, Math.round(Math.hypot(point.x - center.x, point.y - center.y))));
      };
      map.on('mousedown', event => {
        if (!circleRadiusModeRef.current || !circleCenterRef.current || !onCircleRadiusChangeRef.current) return;
        resizingCircle = true;
        map.dragPan.disable();
        setCircleRadius(event);
      });
      map.on('mousemove', event => {
        const point = mapLibreToDayz(activeMap, event.lngLat.lng, event.lngLat.lat);
        const hasPolygonPoint = zonesRef.current.some(zone => zone.isDraft && zone.geometry.type === 'POLYGON' && zone.geometry.points.length > 0);
        if (point && hasPolygonPoint && isPositionInsideMap(activeMap, point)) {
          queuedPreviewPoint = point;
          if (previewFrame === undefined) {
            previewFrame = requestAnimationFrame(() => {
              previewFrame = undefined;
              if (queuedPreviewPoint) onMapMoveRef.current?.(queuedPreviewPoint);
            });
          }
        }
        if (resizingCircle) setCircleRadius(event);
      });
      map.on('mouseup', () => {
        if (!resizingCircle) return;
        resizingCircle = false;
        map.dragPan.enable();
      });
      map.fitBounds([northWest, southEast], { padding: 24, duration: 0 });
      setMapReady(true);
    });
    return () => { mapRef.current = null; map.remove(); };
  }, [activeMap]);

  useEffect(() => {
    const source = mapRef.current?.getSource('zones') as GeoJSONSource | undefined;
    source?.setData(featureCollection(activeMap, zones, previewPoint));
  }, [activeMap, previewPoint?.x, previewPoint?.y, zones]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !focusPoint) return;
    map.easeTo({ center: [...dayzToMapLibre(activeMap, focusPoint)] as [number, number], zoom: Math.max(map.getZoom(), 13), duration: 350 });
  }, [activeMap, focusPoint?.x, focusPoint?.y, mapReady]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const markers = zones.filter(zone => zone.isDraft).flatMap(zone => {
      const points = zone.geometry.type === 'CIRCLE'
        ? [{ x: zone.geometry.x, y: zone.geometry.y }]
        : zone.geometry.points;
      return points.map((point, index) => {
        const element = document.createElement('div');
        element.className = 'radar-zone-point';
        element.title = zone.geometry.type === 'CIRCLE' ? 'Kreismittelpunkt' : `Polygonpunkt ${index + 1}`;
        element.setAttribute('aria-hidden', 'true');
        Object.assign(element.style, {
          width: '22px', height: '22px', borderRadius: '9999px', background: '#dc2626', border: '3px solid #ffffff',
          boxShadow: '0 0 0 4px rgba(127, 29, 29, 0.75), 0 2px 8px rgba(0, 0, 0, 0.75)', pointerEvents: 'none',
        });
        return new maplibregl.Marker({ element, anchor: 'center' }).setLngLat([...dayzToMapLibre(activeMap, point)] as [number, number]).addTo(map);
      });
    });
    return () => { markers.forEach(marker => marker.remove()); };
  }, [activeMap, mapReady, zones]);

  return <div className="relative h-[28rem] overflow-hidden border border-border/70"><div ref={container} className={`h-full w-full ${onMapClick ? 'cursor-crosshair' : ''}`} aria-label="DayZ Radar-Karte" /><p className="pointer-events-none absolute bottom-1 right-1 bg-bg/85 px-1.5 py-0.5 text-[10px] text-muted">DayZ Central Economy · ADPL-SA</p>{error && <p role="alert" className="absolute inset-x-3 bottom-3 bg-bg/95 p-2 text-sm text-danger">{error}</p>}</div>;
}