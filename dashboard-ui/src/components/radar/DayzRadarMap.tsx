import { useEffect, useRef, useState } from 'react';
import * as maplibregl from 'maplibre-gl';
import { type GeoJSONSource, type Map as MapLibreMap } from 'maplibre-gl';
import type { Feature, FeatureCollection } from 'geojson';
import 'maplibre-gl/dist/maplibre-gl.css';
import { dayzToMapLibre, isPositionInsideMap, mapLibreToDayz, RADAR_MAP_CALIBRATIONS, type RadarMap } from '@radar-coordinates';

type Point = { x: number; y: number };
type CircleGeometry = { type: 'CIRCLE'; x: number; y: number; radiusMeters: number };
type PolygonGeometry = { type: 'POLYGON'; points: Point[] };
type ZoneGeometry = CircleGeometry | PolygonGeometry;

export type GeometryInteractionMode = 'IDLE' | 'CIRCLE_CREATE' | 'CIRCLE_EDIT' | 'POLYGON_DRAW' | 'POLYGON_EDIT';

export interface MapZone {
  id: string;
  name: string;
  isActive: boolean;
  isDraft?: boolean;
  geometry: ZoneGeometry;
}

interface DayzRadarMapProps {
  activeMap: RadarMap;
  zones: MapZone[];
  interactionMode?: GeometryInteractionMode;
  onMapClick?: (point: Point) => void;
  focusPoint?: Point;
  onCircleCreate?: (center: Point, radiusMeters: number) => void;
  onCircleCenterChange?: (point: Point) => void;
  onCircleRadiusChange?: (radiusMeters: number) => void;
  onPolygonClose?: () => void;
  onPolygonVertexChange?: (index: number, point: Point) => void;
  onPolygonInsert?: (index: number, point: Point) => void;
  onPolygonMove?: (points: Point[]) => void;
}

function circlePoints(map: RadarMap, x: number, y: number, radiusMeters: number): number[][] {
  return Array.from({ length: 65 }, (_, index) => {
    const radians = (index / 64) * Math.PI * 2;
    const [longitude, latitude] = dayzToMapLibre(map, { x: x + Math.cos(radians) * radiusMeters, y: y + Math.sin(radians) * radiusMeters });
    return [longitude, latitude];
  });
}

function maxCircleRadius(map: RadarMap, center: Point): number {
  const calibration = RADAR_MAP_CALIBRATIONS[map];
  return Math.max(1, Math.min(center.x, calibration.widthMeters - center.x, center.y, calibration.heightMeters - center.y));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function clampCircleCenter(map: RadarMap, point: Point, radiusMeters: number): Point {
  const calibration = RADAR_MAP_CALIBRATIONS[map];
  const maxX = Math.max(radiusMeters, calibration.widthMeters - radiusMeters);
  const maxY = Math.max(radiusMeters, calibration.heightMeters - radiusMeters);
  return {
    x: clamp(point.x, radiusMeters, maxX),
    y: clamp(point.y, radiusMeters, maxY),
  };
}

function withDraftGeometry(zones: MapZone[], transientGeometry?: ZoneGeometry): MapZone[] {
  if (!transientGeometry) return zones;
  return zones.map(zone => zone.isDraft ? { ...zone, geometry: transientGeometry } : zone);
}

function featureCollection(
  map: RadarMap,
  zones: MapZone[],
  interactionMode: GeometryInteractionMode,
  previewPoint?: Point,
  transientGeometry?: ZoneGeometry,
): FeatureCollection {
  const features: Feature[] = [];
  for (const zone of withDraftGeometry(zones, transientGeometry)) {
    const properties = { id: zone.id, name: zone.name, active: zone.isActive, draft: zone.isDraft === true };
    if (zone.geometry.type === 'CIRCLE') {
      if (zone.isDraft && interactionMode === 'CIRCLE_CREATE' && !transientGeometry) continue;
      features.push({ type: 'Feature', properties, geometry: { type: 'Polygon', coordinates: [circlePoints(map, zone.geometry.x, zone.geometry.y, zone.geometry.radiusMeters)] } });
      if (!zone.isDraft) features.push({ type: 'Feature', properties: { ...properties, center: true }, geometry: { type: 'Point', coordinates: [...dayzToMapLibre(map, zone.geometry)] } });
      continue;
    }

    const points = zone.geometry.points.map(point => [...dayzToMapLibre(map, point)] as [number, number]);
    const openDraft = zone.isDraft && interactionMode === 'POLYGON_DRAW';
    if (openDraft) {
      if (points.length >= 2) features.push({ type: 'Feature', properties: { ...properties, open: true }, geometry: { type: 'LineString', coordinates: points } });
      if (points.length > 0 && previewPoint) {
        features.push({
          type: 'Feature',
          properties: { ...properties, drawing: true },
          geometry: { type: 'LineString', coordinates: [points[points.length - 1], [...dayzToMapLibre(map, previewPoint)]] },
        });
      }
    } else if (points.length >= 3) {
      features.push({ type: 'Feature', properties, geometry: { type: 'Polygon', coordinates: [[...points, points[0]]] } });
    } else if (points.length === 2) {
      features.push({ type: 'Feature', properties, geometry: { type: 'LineString', coordinates: points } });
    }

    if (!zone.isDraft) {
      zone.geometry.points.forEach((point, index) => features.push({ type: 'Feature', properties: { ...properties, vertex: index + 1 }, geometry: { type: 'Point', coordinates: [...dayzToMapLibre(map, point)] } }));
    }
  }
  return { type: 'FeatureCollection', features };
}

function setZoneSourceData(
  map: MapLibreMap,
  radarMap: RadarMap,
  zones: MapZone[],
  interactionMode: GeometryInteractionMode,
  previewPoint?: Point,
  transientGeometry?: ZoneGeometry,
): void {
  const source = map.getSource('zones') as GeoJSONSource | undefined;
  source?.setData(featureCollection(radarMap, zones, interactionMode, previewPoint, transientGeometry));
}

function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

export function DayzRadarMap({
  activeMap,
  zones,
  interactionMode = 'IDLE',
  onMapClick,
  focusPoint,
  onCircleCreate,
  onCircleCenterChange,
  onCircleRadiusChange,
  onPolygonClose,
  onPolygonVertexChange,
  onPolygonInsert,
  onPolygonMove,
}: DayzRadarMapProps) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const zonesRef = useRef(zones);
  const interactionModeRef = useRef(interactionMode);
  const previewPointRef = useRef<Point>();
  const transientGeometryRef = useRef<ZoneGeometry>();
  const polygonVertexMarkersRef = useRef<maplibregl.Marker[]>([]);
  const polygonInsertMarkersRef = useRef<maplibregl.Marker[]>([]);
  const onMapClickRef = useRef(onMapClick);
  const onCircleCreateRef = useRef(onCircleCreate);
  const onCircleCenterChangeRef = useRef(onCircleCenterChange);
  const onCircleRadiusChangeRef = useRef(onCircleRadiusChange);
  const onPolygonCloseRef = useRef(onPolygonClose);
  const onPolygonVertexChangeRef = useRef(onPolygonVertexChange);
  const onPolygonInsertRef = useRef(onPolygonInsert);
  const onPolygonMoveRef = useRef(onPolygonMove);
  const [mapReady, setMapReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { zonesRef.current = zones; }, [zones]);
  useEffect(() => { interactionModeRef.current = interactionMode; }, [interactionMode]);
  useEffect(() => { onMapClickRef.current = onMapClick; }, [onMapClick]);
  useEffect(() => { onCircleCreateRef.current = onCircleCreate; }, [onCircleCreate]);
  useEffect(() => { onCircleCenterChangeRef.current = onCircleCenterChange; }, [onCircleCenterChange]);
  useEffect(() => { onCircleRadiusChangeRef.current = onCircleRadiusChange; }, [onCircleRadiusChange]);
  useEffect(() => { onPolygonCloseRef.current = onPolygonClose; }, [onPolygonClose]);
  useEffect(() => { onPolygonVertexChangeRef.current = onPolygonVertexChange; }, [onPolygonVertexChange]);
  useEffect(() => { onPolygonInsertRef.current = onPolygonInsert; }, [onPolygonInsert]);
  useEffect(() => { onPolygonMoveRef.current = onPolygonMove; }, [onPolygonMove]);

  useEffect(() => {
    setMapReady(false);
    setError(null);
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
      map.addSource('zones', { type: 'geojson', data: featureCollection(activeMap, zonesRef.current, interactionModeRef.current) });
      map.addLayer({ id: 'zone-fill', type: 'fill', source: 'zones', paint: { 'fill-color': '#ef4444', 'fill-opacity': ['case', ['get', 'draft'], 0.3, 0.22] } });
      map.addLayer({ id: 'zone-line', type: 'line', source: 'zones', paint: { 'line-color': '#dc2626', 'line-width': ['case', ['get', 'draft'], 4, 3] } });
      map.addLayer({ id: 'zone-vertices', type: 'circle', source: 'zones', filter: ['==', '$type', 'Point'], paint: { 'circle-radius': 7, 'circle-color': '#dc2626', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2 } });

      let drawingCircle = false;
      let drawnCenter: Point | undefined;
      let polygonDragStart: Point | undefined;
      let polygonDragPoints: Point[] | undefined;
      let polygonDragLatestPoints: Point[] | undefined;

      const redraw = () => setZoneSourceData(map, activeMap, zonesRef.current, interactionModeRef.current, previewPointRef.current, transientGeometryRef.current);

      map.on('click', event => {
        if (drawingCircle || interactionModeRef.current !== 'POLYGON_DRAW') return;
        const point = mapLibreToDayz(activeMap, event.lngLat.lng, event.lngLat.lat);
        if (point && isPositionInsideMap(activeMap, point)) onMapClickRef.current?.(point);
      });

      map.on('mousedown', event => {
        if (interactionModeRef.current !== 'CIRCLE_CREATE' || event.originalEvent.button !== 0) return;
        const rawPoint = mapLibreToDayz(activeMap, event.lngLat.lng, event.lngLat.lat);
        if (!rawPoint) return;
        const center = clampCircleCenter(activeMap, rawPoint, 1);
        drawingCircle = true;
        drawnCenter = center;
        previewPointRef.current = undefined;
        transientGeometryRef.current = { type: 'CIRCLE', x: center.x, y: center.y, radiusMeters: 1 };
        map.dragPan.disable();
        redraw();
      });

      map.on('mousedown', 'zone-fill', event => {
        if (interactionModeRef.current !== 'POLYGON_EDIT' || !onPolygonMoveRef.current) return;
        const zoneId = event.features?.[0]?.properties?.id;
        const zone = zonesRef.current.find(item => item.id === zoneId && item.isDraft && item.geometry.type === 'POLYGON');
        const point = mapLibreToDayz(activeMap, event.lngLat.lng, event.lngLat.lat);
        if (!zone || zone.geometry.type !== 'POLYGON' || !point) return;
        polygonDragStart = point;
        polygonDragPoints = zone.geometry.points.map(vertex => ({ ...vertex }));
        polygonDragLatestPoints = polygonDragPoints;
        map.dragPan.disable();
      });

      map.on('mousemove', event => {
        const point = mapLibreToDayz(activeMap, event.lngLat.lng, event.lngLat.lat);
        if (interactionModeRef.current === 'POLYGON_DRAW') {
          const draftPolygon = zonesRef.current.find(zone => zone.isDraft && zone.geometry.type === 'POLYGON');
          if (point && draftPolygon?.geometry.type === 'POLYGON' && draftPolygon.geometry.points.length > 0 && isPositionInsideMap(activeMap, point)) {
            previewPointRef.current = point;
            redraw();
          }
        }

        if (drawingCircle && drawnCenter && point) {
          const radiusMeters = Math.max(1, Math.min(Math.round(Math.hypot(point.x - drawnCenter.x, point.y - drawnCenter.y)), Math.floor(maxCircleRadius(activeMap, drawnCenter))));
          transientGeometryRef.current = { type: 'CIRCLE', x: drawnCenter.x, y: drawnCenter.y, radiusMeters };
          redraw();
        }

        if (polygonDragStart && polygonDragPoints && point) {
          const movedPoints = polygonDragPoints.map(vertex => ({ x: vertex.x + point.x - polygonDragStart!.x, y: vertex.y + point.y - polygonDragStart!.y }));
          if (!movedPoints.every(vertex => isPositionInsideMap(activeMap, vertex))) return;
          polygonDragLatestPoints = movedPoints;
          transientGeometryRef.current = { type: 'POLYGON', points: movedPoints };
          polygonVertexMarkersRef.current.forEach((marker, index) => marker.setLngLat([...dayzToMapLibre(activeMap, movedPoints[index])] as [number, number]));
          polygonInsertMarkersRef.current.forEach((marker, index) => marker.setLngLat([...dayzToMapLibre(activeMap, midpoint(movedPoints[index], movedPoints[(index + 1) % movedPoints.length]))] as [number, number]));
          redraw();
        }
      });

      map.on('mouseup', () => {
        if (drawingCircle) {
          drawingCircle = false;
          map.dragPan.enable();
          const geometry = transientGeometryRef.current;
          const center = drawnCenter;
          drawnCenter = undefined;
          if (geometry?.type === 'CIRCLE' && center) onCircleCreateRef.current?.(center, geometry.radiusMeters);
          return;
        }
        if (polygonDragStart) {
          polygonDragStart = undefined;
          polygonDragPoints = undefined;
          map.dragPan.enable();
          if (polygonDragLatestPoints) onPolygonMoveRef.current?.(polygonDragLatestPoints);
          polygonDragLatestPoints = undefined;
        }
      });

      map.on('mouseenter', 'zone-fill', () => { if (interactionModeRef.current === 'POLYGON_EDIT') map.getCanvas().style.cursor = 'move'; });
      map.on('mouseleave', 'zone-fill', () => {
        map.getCanvas().style.cursor = interactionModeRef.current === 'POLYGON_DRAW' || interactionModeRef.current === 'CIRCLE_CREATE' ? 'crosshair' : '';
      });
      map.getCanvas().addEventListener('mouseleave', () => {
        if (interactionModeRef.current === 'POLYGON_DRAW' && previewPointRef.current) {
          previewPointRef.current = undefined;
          redraw();
        }
      });

      map.fitBounds([northWest, southEast], { padding: 24, duration: 0 });
      setMapReady(true);
    });

    return () => {
      polygonVertexMarkersRef.current = [];
      polygonInsertMarkersRef.current = [];
      mapRef.current = null;
      map.remove();
    };
  }, [activeMap]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    transientGeometryRef.current = undefined;
    if (interactionMode !== 'POLYGON_DRAW') previewPointRef.current = undefined;
    setZoneSourceData(map, activeMap, zones, interactionMode, previewPointRef.current);
    map.getCanvas().style.cursor = interactionMode === 'POLYGON_DRAW' || interactionMode === 'CIRCLE_CREATE' ? 'crosshair' : '';
  }, [activeMap, interactionMode, mapReady, zones]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !focusPoint) return;
    map.easeTo({ center: [...dayzToMapLibre(activeMap, focusPoint)] as [number, number], zoom: Math.max(map.getZoom(), 13), duration: 350 });
  }, [activeMap, focusPoint, mapReady]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const markers: maplibregl.Marker[] = [];
    const vertexMarkers: maplibregl.Marker[] = [];
    const insertMarkers: maplibregl.Marker[] = [];
    const draft = zones.find(zone => zone.isDraft);
    if (!draft) {
      polygonVertexMarkersRef.current = [];
      polygonInsertMarkersRef.current = [];
      return;
    }

    const redraw = () => setZoneSourceData(map, activeMap, zonesRef.current, interactionModeRef.current, previewPointRef.current, transientGeometryRef.current);

    if (draft.geometry.type === 'CIRCLE' && interactionMode === 'CIRCLE_EDIT') {
      const circle = draft.geometry;
      let latestRadius = circle.radiusMeters;
      const radiusElement = document.createElement('div');
      radiusElement.className = 'radar-zone-radius-handle';
      radiusElement.title = 'Kreisradius ändern';
      radiusElement.setAttribute('aria-label', 'Kreisradius ändern');
      Object.assign(radiusElement.style, { width: '18px', height: '18px', borderRadius: '9999px', background: '#ffffff', border: '4px solid #dc2626', boxShadow: '0 0 0 3px rgba(127, 29, 29, 0.75)', cursor: 'ew-resize' });
      const radiusMarker = new maplibregl.Marker({ element: radiusElement, anchor: 'center', draggable: true }).setLngLat([...dayzToMapLibre(activeMap, { x: circle.x + circle.radiusMeters, y: circle.y })] as [number, number]).addTo(map);
      radiusMarker.on('drag', () => {
        const raw = mapLibreToDayz(activeMap, radiusMarker.getLngLat().lng, radiusMarker.getLngLat().lat);
        if (!raw) return;
        const center = { x: circle.x, y: circle.y };
        const maxRadius = Math.floor(maxCircleRadius(activeMap, center));
        latestRadius = Math.max(1, Math.min(Math.round(Math.hypot(raw.x - center.x, raw.y - center.y)), maxRadius));
        transientGeometryRef.current = { type: 'CIRCLE', x: center.x, y: center.y, radiusMeters: latestRadius };
        redraw();
      });
      radiusMarker.on('dragend', () => onCircleRadiusChangeRef.current?.(latestRadius));

      let latestCenter: Point = { x: circle.x, y: circle.y };
      const centerElement = document.createElement('div');
      centerElement.className = 'radar-zone-point radar-zone-center-handle';
      centerElement.title = 'Kreismittelpunkt verschieben';
      Object.assign(centerElement.style, { width: '22px', height: '22px', borderRadius: '9999px', background: '#dc2626', border: '3px solid #ffffff', boxShadow: '0 0 0 4px rgba(127, 29, 29, 0.75), 0 2px 8px rgba(0, 0, 0, 0.75)', cursor: 'move' });
      const centerMarker = new maplibregl.Marker({ element: centerElement, anchor: 'center', draggable: true }).setLngLat([...dayzToMapLibre(activeMap, latestCenter)] as [number, number]).addTo(map);
      centerMarker.on('drag', () => {
        const raw = mapLibreToDayz(activeMap, centerMarker.getLngLat().lng, centerMarker.getLngLat().lat);
        if (!raw) return;
        latestCenter = clampCircleCenter(activeMap, raw, circle.radiusMeters);
        centerMarker.setLngLat([...dayzToMapLibre(activeMap, latestCenter)] as [number, number]);
        transientGeometryRef.current = { type: 'CIRCLE', x: latestCenter.x, y: latestCenter.y, radiusMeters: circle.radiusMeters };
        radiusMarker.setLngLat([...dayzToMapLibre(activeMap, { x: latestCenter.x + circle.radiusMeters, y: latestCenter.y })] as [number, number]);
        redraw();
      });
      centerMarker.on('dragend', () => onCircleCenterChangeRef.current?.(latestCenter));
      markers.push(centerMarker, radiusMarker);
    }

    if (draft.geometry.type === 'POLYGON') {
      const points = draft.geometry.points;
      points.forEach((point, index) => {
        const closeHandle = interactionMode === 'POLYGON_DRAW' && index === 0 && points.length >= 3;
        const element = document.createElement('div');
        element.className = closeHandle ? 'radar-zone-point radar-zone-close-handle' : 'radar-zone-point';
        element.title = closeHandle ? 'Zone schließen' : `Polygonpunkt ${index + 1}`;
        element.dataset.radarHandle = closeHandle ? 'polygon-close' : 'polygon-vertex';
        Object.assign(element.style, {
          width: closeHandle ? '26px' : '22px', height: closeHandle ? '26px' : '22px', borderRadius: '9999px', background: '#dc2626', border: closeHandle ? '4px solid #ffffff' : '3px solid #ffffff',
          boxShadow: closeHandle ? '0 0 0 6px rgba(239, 68, 68, 0.4), 0 2px 10px rgba(0, 0, 0, 0.8)' : '0 0 0 4px rgba(127, 29, 29, 0.75), 0 2px 8px rgba(0, 0, 0, 0.75)',
          cursor: closeHandle ? 'pointer' : interactionMode === 'POLYGON_EDIT' ? 'move' : 'crosshair',
        });
        const marker = new maplibregl.Marker({ element, anchor: 'center', draggable: interactionMode === 'POLYGON_EDIT' }).setLngLat([...dayzToMapLibre(activeMap, point)] as [number, number]).addTo(map);
        if (closeHandle) {
          element.addEventListener('click', event => { event.stopPropagation(); onPolygonCloseRef.current?.(); });
        }
        if (interactionMode === 'POLYGON_EDIT') {
          let latestPoint = point;
          marker.on('drag', () => {
            const next = mapLibreToDayz(activeMap, marker.getLngLat().lng, marker.getLngLat().lat);
            if (!next || !isPositionInsideMap(activeMap, next)) return;
            latestPoint = next;
            const moved = points.map((current, currentIndex) => currentIndex === index ? next : current);
            transientGeometryRef.current = { type: 'POLYGON', points: moved };
            redraw();
          });
          marker.on('dragend', () => onPolygonVertexChangeRef.current?.(index, latestPoint));
        }
        markers.push(marker);
        vertexMarkers.push(marker);
      });

      if (interactionMode === 'POLYGON_EDIT' && points.length >= 3) {
        points.forEach((point, index) => {
          const next = points[(index + 1) % points.length];
          const element = document.createElement('div');
          element.className = 'radar-zone-insert-handle';
          element.dataset.radarHandle = 'polygon-insert';
          element.title = 'Neuen Eckpunkt einfügen';
          Object.assign(element.style, { width: '12px', height: '12px', borderRadius: '9999px', background: '#ffffff', border: '2px solid #dc2626', boxShadow: '0 0 0 2px rgba(127, 29, 29, 0.5)', cursor: 'copy' });
          let latestPoint = midpoint(point, next);
          const marker = new maplibregl.Marker({ element, anchor: 'center', draggable: true }).setLngLat([...dayzToMapLibre(activeMap, latestPoint)] as [number, number]).addTo(map);
          marker.on('drag', () => {
            const candidate = mapLibreToDayz(activeMap, marker.getLngLat().lng, marker.getLngLat().lat);
            if (!candidate || !isPositionInsideMap(activeMap, candidate)) return;
            latestPoint = candidate;
            transientGeometryRef.current = { type: 'POLYGON', points: [...points.slice(0, index + 1), candidate, ...points.slice(index + 1)] };
            redraw();
          });
          marker.on('dragend', () => onPolygonInsertRef.current?.(index + 1, latestPoint));
          markers.push(marker);
          insertMarkers.push(marker);
        });
      }
    }

    polygonVertexMarkersRef.current = vertexMarkers;
    polygonInsertMarkersRef.current = insertMarkers;
    return () => {
      markers.forEach(marker => marker.remove());
      polygonVertexMarkersRef.current = [];
      polygonInsertMarkersRef.current = [];
    };
  }, [activeMap, interactionMode, mapReady, zones]);

  const mapIsDrawing = interactionMode === 'POLYGON_DRAW' || interactionMode === 'CIRCLE_CREATE';
  return <div className="relative h-[28rem] overflow-hidden border border-border/70" data-radar-interaction-mode={interactionMode} data-radar-polygon-open={interactionMode === 'POLYGON_DRAW' ? 'true' : 'false'}><div ref={container} className={`h-full w-full ${mapIsDrawing ? 'cursor-crosshair' : ''}`} aria-label="DayZ Radar-Karte" /><p className="pointer-events-none absolute bottom-1 right-1 bg-bg/85 px-1.5 py-0.5 text-[10px] text-muted">DayZ Central Economy · ADPL-SA</p>{error && <p role="alert" className="absolute inset-x-3 bottom-3 bg-bg/95 p-2 text-sm text-danger">{error}</p>}</div>;
}
