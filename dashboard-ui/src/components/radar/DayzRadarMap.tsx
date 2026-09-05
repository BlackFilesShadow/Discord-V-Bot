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

export function DayzRadarMap({ activeMap, zones, onMapClick, onMapMove, focusPoint, onCircleRadiusChange, previewPoint, circleCreateMode, onCircleCenterChange, onCircleCreateEnd, polygonDrawing, onPolygonClose, onPolygonVertexChange, onPolygonInsert, onPolygonMove }: { activeMap: RadarMap; zones: MapZone[]; onMapClick?: (point: Point) => void; onMapMove?: (point: Point) => void; focusPoint?: Point; onCircleRadiusChange?: (radiusMeters: number) => void; previewPoint?: Point; circleCreateMode?: boolean; onCircleCenterChange?: (point: Point) => void; onCircleCreateEnd?: () => void; polygonDrawing?: boolean; onPolygonClose?: () => void; onPolygonVertexChange?: (index: number, point: Point) => void; onPolygonInsert?: (index: number, point: Point) => void; onPolygonMove?: (points: Point[]) => void }) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const zonesRef = useRef(zones);
  const onMapClickRef = useRef(onMapClick);
  const onMapMoveRef = useRef(onMapMove);
  const onCircleRadiusChangeRef = useRef(onCircleRadiusChange);
  const circleCreateModeRef = useRef(circleCreateMode);
  const onCircleCenterChangeRef = useRef(onCircleCenterChange);
  const onCircleCreateEndRef = useRef(onCircleCreateEnd);
  const onPolygonMoveRef = useRef(onPolygonMove);
  const [mapReady, setMapReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { zonesRef.current = zones; }, [zones]);
  useEffect(() => { onMapClickRef.current = onMapClick; }, [onMapClick]);
  useEffect(() => { onMapMoveRef.current = onMapMove; }, [onMapMove]);
  useEffect(() => { onCircleRadiusChangeRef.current = onCircleRadiusChange; }, [onCircleRadiusChange]);
  useEffect(() => { circleCreateModeRef.current = circleCreateMode; }, [circleCreateMode]);
  useEffect(() => { onCircleCenterChangeRef.current = onCircleCenterChange; }, [onCircleCenterChange]);
  useEffect(() => { onCircleCreateEndRef.current = onCircleCreateEnd; }, [onCircleCreateEnd]);
  useEffect(() => { onPolygonMoveRef.current = onPolygonMove; }, [onPolygonMove]);

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
        if (drawingCircle) return;
        const point = mapLibreToDayz(activeMap, event.lngLat.lng, event.lngLat.lat);
        if (point && isPositionInsideMap(activeMap, point)) onMapClickRef.current?.(point);
      });
      let drawingCircle = false;
      let drawnCenter: Point | undefined;
      let polygonDragStart: Point | undefined;
      let polygonDragPoints: Point[] | undefined;
      let previewFrame: number | undefined;
      let queuedPreviewPoint: Point | undefined;
      map.on('mousedown', event => {
        const point = mapLibreToDayz(activeMap, event.lngLat.lng, event.lngLat.lat);
        if (circleCreateModeRef.current && point && isPositionInsideMap(activeMap, point)) {
          drawingCircle = true;
          drawnCenter = point;
          map.dragPan.disable();
          onCircleCenterChangeRef.current?.(point);
          onCircleRadiusChangeRef.current?.(1);
          return;
        }
      });
      map.on('mousedown', 'zone-fill', event => {
        if (polygonDrawing || circleCreateModeRef.current || !onPolygonMoveRef.current) return;
        const zoneId = event.features?.[0]?.properties?.id;
        const zone = zonesRef.current.find(item => item.id === zoneId && item.isDraft && item.geometry.type === 'POLYGON');
        const point = mapLibreToDayz(activeMap, event.lngLat.lng, event.lngLat.lat);
        if (!zone || zone.geometry.type !== 'POLYGON' || !point) return;
        polygonDragStart = point;
        polygonDragPoints = zone.geometry.points;
        map.dragPan.disable();
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
        if (drawingCircle && drawnCenter && point) onCircleRadiusChangeRef.current?.(Math.max(1, Math.round(Math.hypot(point.x - drawnCenter.x, point.y - drawnCenter.y))));
        if (polygonDragStart && polygonDragPoints && point) {
          const movedPoints = polygonDragPoints.map(vertex => ({ x: vertex.x + point.x - polygonDragStart!.x, y: vertex.y + point.y - polygonDragStart!.y }));
          if (movedPoints.every(vertex => isPositionInsideMap(activeMap, vertex))) onPolygonMoveRef.current?.(movedPoints);
        }
      });
      map.on('mouseup', () => {
        if (drawingCircle) {
          drawingCircle = false;
          drawnCenter = undefined;
          map.dragPan.enable();
          onCircleCreateEndRef.current?.();
          return;
        }
        if (polygonDragStart) {
          polygonDragStart = undefined;
          polygonDragPoints = undefined;
          map.dragPan.enable();
        }
      });
      map.on('mouseenter', 'zone-fill', () => { if (!polygonDrawing && !circleCreateModeRef.current) map.getCanvas().style.cursor = 'move'; });
      map.on('mouseleave', 'zone-fill', () => { map.getCanvas().style.cursor = ''; });
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
      const points = zone.geometry.type === 'CIRCLE' ? [{ x: zone.geometry.x, y: zone.geometry.y }] : zone.geometry.points;
      return points.map((point, index) => {
        const element = document.createElement('div');
        element.className = 'radar-zone-point';
        element.title = zone.geometry.type === 'CIRCLE' ? 'Kreismittelpunkt' : `Polygonpunkt ${index + 1}`;
        element.setAttribute('aria-hidden', 'true');
        Object.assign(element.style, {
          width: '22px', height: '22px', borderRadius: '9999px', background: '#dc2626', border: '3px solid #ffffff',
          boxShadow: '0 0 0 4px rgba(127, 29, 29, 0.75), 0 2px 8px rgba(0, 0, 0, 0.75)', cursor: 'move',
        });
        const marker = new maplibregl.Marker({ element, anchor: 'center', draggable: zone.geometry.type === 'CIRCLE' || !polygonDrawing }).setLngLat([...dayzToMapLibre(activeMap, point)] as [number, number]).addTo(map);
        if (zone.geometry.type === 'POLYGON') {
          element.addEventListener('click', event => { event.stopPropagation(); if (polygonDrawing && index === 0 && points.length >= 3) onPolygonClose?.(); });
          marker.on('dragend', () => { const position = mapLibreToDayz(activeMap, marker.getLngLat().lng, marker.getLngLat().lat); if (position) onPolygonVertexChange?.(index, position); });
        } else {
          marker.on('dragend', () => { const position = mapLibreToDayz(activeMap, marker.getLngLat().lng, marker.getLngLat().lat); if (position) onCircleCenterChange?.(position); });
        }
        return marker;
      });
    });
    for (const zone of zones.filter((zone): zone is MapZone & { geometry: Extract<MapZone['geometry'], { type: 'CIRCLE' }> } => zone.isDraft === true && zone.geometry.type === 'CIRCLE' && circleCreateMode !== true)) {
      const element = document.createElement('div');
      element.className = 'maplibregl-marker radar-zone-radius-handle';
      element.title = 'Kreisradius ändern';
      element.setAttribute('aria-label', 'Kreisradius ändern');
      Object.assign(element.style, { width: '18px', height: '18px', borderRadius: '9999px', background: '#ffffff', border: '4px solid #dc2626', boxShadow: '0 0 0 3px rgba(127, 29, 29, 0.75)', cursor: 'ew-resize' });
      const handlePoint = { x: Math.min(RADAR_MAP_CALIBRATIONS[activeMap].widthMeters, zone.geometry.x + zone.geometry.radiusMeters), y: zone.geometry.y };
      const marker = new maplibregl.Marker({ element, anchor: 'center', draggable: true }).setLngLat([...dayzToMapLibre(activeMap, handlePoint)] as [number, number]).addTo(map);
      marker.on('drag', () => {
        const point = mapLibreToDayz(activeMap, marker.getLngLat().lng, marker.getLngLat().lat);
        if (point) onCircleRadiusChange?.(Math.max(1, Math.round(Math.hypot(point.x - zone.geometry.x, point.y - zone.geometry.y))));
      });
      markers.push(marker);
    }
    for (const zone of zones.filter((zone): zone is MapZone & { geometry: Extract<MapZone['geometry'], { type: 'POLYGON' }> } => zone.isDraft === true && zone.geometry.type === 'POLYGON' && zone.geometry.points.length >= 3 && polygonDrawing !== true)) {
      zone.geometry.points.forEach((point, index, points) => {
        const next = points[(index + 1) % points.length];
        const element = document.createElement('div');
        element.className = 'maplibregl-marker radar-zone-insert-handle';
        element.dataset.radarHandle = 'polygon-insert';
        Object.assign(element.style, { width: '12px', height: '12px', borderRadius: '9999px', background: '#ffffff', border: '2px solid #dc2626', cursor: 'copy' });
        const marker = new maplibregl.Marker({ element, anchor: 'center', draggable: true }).setLngLat([...dayzToMapLibre(activeMap, { x: (point.x + next.x) / 2, y: (point.y + next.y) / 2 })] as [number, number]).addTo(map);
        marker.on('dragend', () => { const position = mapLibreToDayz(activeMap, marker.getLngLat().lng, marker.getLngLat().lat); if (position) onPolygonInsert?.(index + 1, position); });
        markers.push(marker);
      });
    }
    return () => { markers.forEach(marker => marker.remove()); };
  }, [activeMap, circleCreateMode, mapReady, onCircleCenterChange, onCircleRadiusChange, onPolygonClose, onPolygonInsert, onPolygonVertexChange, polygonDrawing, zones]);

  return <div className="relative h-[28rem] overflow-hidden border border-border/70"><div ref={container} className={`h-full w-full ${onMapClick ? 'cursor-crosshair' : ''}`} aria-label="DayZ Radar-Karte" /><p className="pointer-events-none absolute bottom-1 right-1 bg-bg/85 px-1.5 py-0.5 text-[10px] text-muted">DayZ Central Economy · ADPL-SA</p>{error && <p role="alert" className="absolute inset-x-3 bottom-3 bg-bg/95 p-2 text-sm text-danger">{error}</p>}</div>;
}