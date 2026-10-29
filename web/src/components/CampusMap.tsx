import 'maplibre-gl/dist/maplibre-gl.css'
import '../map/worker'
import type { FeatureCollection, Point } from 'geojson'
import type { ExpressionSpecification, FilterSpecification } from 'maplibre-gl'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AttributionControl, Layer, Map, Source, useMap, type MapLayerMouseEvent, type MapRef } from 'react-map-gl/maplibre'
import type { Building } from '../lib/buildings'
import { LocateIcon } from './icons'
import { CAMPUS_CENTER, DROP_ACCENT } from '../lib/campus'
import { campusBounds, insideBounds, type Bounds } from '../lib/geo'
import { BASEMAP_STYLE, LABEL_FONT, LANDMARKS, tuneBasemap } from '../map/basemap'
import { withHeights } from '../map/geometry'
import { usePresence } from '../session/presence'

const PITCH = 45
const BEARING = -17
const START_ZOOM = 16
const FOLLOW_ZOOM = 17
const NEUTRAL_BUILDING = '#e7e5e4'
/** A pale Penn State blue for buildings with upcoming campus events. */
const EVENT_BUILDING = '#c9d6ec'
const NO_BUILDINGS: ReadonlySet<string> = new Set()
const PULSE_MS = 900

const [OLD_MAIN_LAT, OLD_MAIN_LNG] = CAMPUS_CENTER

/** Handle for tests/e2e (the map lives in WebGL, so tests query it directly). Only in dev or a VITE_E2E build. */
const exposeForTests = (ref: MapRef | null) => {
  if (ref) (window as unknown as { __walkpsuMap: unknown }).__walkpsuMap = ref.getMap()
}

type Props = {
  buildings: Building[]
  /** Building numbers hosting an active drop: drawn in the accent color with a soft pulse. */
  highlighted: ReadonlySet<string>
  /** Building numbers hosting an upcoming campus event: a quiet blue tint, no pulse. A highlight wins over a tint. */
  tinted?: ReadonlySet<string>
  className: string
  interactiveLayerIds?: string[]
  onClick?: (e: MapLayerMouseEvent) => void
  children?: ReactNode
}

/** Minimal 2.5D campus map: pitched camera, extruded buildings, locked to campus. Shared by players and admins. */
function CampusMap({ buildings, highlighted, tinted = NO_BUILDINGS, className, interactiveLayerIds, onClick, children }: Props) {
  const bounds = useMemo(() => (buildings.length ? campusBounds(buildings) : null), [buildings])
  const [minZoom, setMinZoom] = useState(12)
  const extruded = useMemo<FeatureCollection>(() => ({ type: 'FeatureCollection', features: withHeights(buildings) }), [buildings])
  const landmarks = useMemo<FeatureCollection<Point>>(
    () => ({
      type: 'FeatureCollection',
      features: buildings
        .filter((b) => LANDMARKS[b.properties.num])
        .map((b) => ({ type: 'Feature', properties: { name: LANDMARKS[b.properties.num] }, geometry: { type: 'Point', coordinates: [b.properties.lng, b.properties.lat] } })),
    }),
    [buildings],
  )
  const isActive = useMemo<FilterSpecification>(() => ['in', ['get', 'num'], ['literal', [...highlighted]]], [highlighted])
  const notActive = useMemo<FilterSpecification>(() => ['!', isActive as ExpressionSpecification], [isActive])
  const baseColor = useMemo<ExpressionSpecification>(
    () => ['case', ['in', ['get', 'num'], ['literal', [...tinted]]], EVENT_BUILDING, NEUTRAL_BUILDING],
    [tinted],
  )

  return (
    <div className={className}>
      <Map
        ref={import.meta.env.DEV || import.meta.env.VITE_E2E ? exposeForTests : undefined}
        mapStyle={BASEMAP_STYLE}
        initialViewState={{ latitude: OLD_MAIN_LAT, longitude: OLD_MAIN_LNG, zoom: START_ZOOM, pitch: PITCH, bearing: BEARING }}
        maxBounds={bounds ? [...bounds[0], ...bounds[1]] : undefined}
        minZoom={minZoom}
        maxPitch={60}
        attributionControl={false}
        interactiveLayerIds={interactiveLayerIds}
        onClick={onClick}
        onLoad={(e) => {
          tuneBasemap(e.target)
          // Start the required attribution collapsed to its small (i) button.
          e.target.getContainer().querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show')
        }}
        // Soft, even light so extruded walls read as pale gray rather than dark.
        light={{ anchor: 'viewport', color: '#ffffff', intensity: 0.2, position: [1.2, 210, 30] }}
        style={{ width: '100%', height: '100%' }}
      >
        <Source id="buildings" type="geojson" data={extruded}>
          <Layer
            id="buildings-base"
            type="fill-extrusion"
            filter={notActive}
            paint={{ 'fill-extrusion-color': baseColor, 'fill-extrusion-height': ['get', 'height'], 'fill-extrusion-opacity': 0.9 }}
          />
          <Layer
            id="buildings-active-glow"
            type="line"
            filter={isActive}
            paint={{ 'line-color': DROP_ACCENT, 'line-width': 10, 'line-blur': 8, 'line-opacity': 0.6, 'line-opacity-transition': { duration: PULSE_MS } }}
          />
          <Layer
            id="buildings-active"
            type="fill-extrusion"
            filter={isActive}
            paint={{
              'fill-extrusion-color': DROP_ACCENT,
              'fill-extrusion-height': ['+', ['get', 'height'], 2],
              'fill-extrusion-opacity': 0.95,
              'fill-extrusion-opacity-transition': { duration: PULSE_MS },
            }}
          />
        </Source>
        <Source id="landmarks" type="geojson" data={landmarks}>
          <Layer
            id="landmarks"
            type="symbol"
            layout={{ 'text-field': ['get', 'name'], 'text-font': LABEL_FONT, 'text-size': 12, 'text-offset': [0, -1.2] }}
            paint={{ 'text-color': '#57534e', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 }}
          />
        </Source>
        {children}
        <AttributionControl position="bottom-left" compact />
        <Pulse enabled={highlighted.size > 0} />
        {bounds && <CampusCamera bounds={bounds} onMinZoom={setMinZoom} />}
      </Map>
    </div>
  )
}

/** Breathes the highlighted buildings' opacity so a fresh drop catches the eye. */
function Pulse({ enabled }: { enabled: boolean }) {
  const { current: map } = useMap()
  useEffect(() => {
    if (!enabled || !map) return
    let bright = true
    const tick = setInterval(() => {
      bright = !bright
      if (!map.getLayer('buildings-active')) return
      map.getMap().setPaintProperty('buildings-active', 'fill-extrusion-opacity', bright ? 0.95 : 0.65)
      map.getMap().setPaintProperty('buildings-active-glow', 'line-opacity', bright ? 0.6 : 0.15)
    }, PULSE_MS)
    return () => clearInterval(tick)
  }, [enabled, map])
  return null
}

/** Opens on the player if they're on campus, otherwise Old Main; floats a recenter button. */
function CampusCamera({ bounds, onMinZoom }: { bounds: Bounds; onMinZoom: (zoom: number) => void }) {
  const { current: map } = useMap()
  const { position } = usePresence()
  const followed = useRef(false)

  useEffect(() => {
    if (!map) return
    // The furthest-out zoom that still shows only the campus box.
    const fit = map.getMap().cameraForBounds(bounds, { padding: 0, bearing: BEARING })
    if (fit?.zoom) onMinZoom(Math.max(12, fit.zoom))
  }, [map, bounds, onMinZoom])

  const target = () => {
    const c = position?.coords
    return c && insideBounds(bounds, c.latitude, c.longitude)
      ? { center: [c.longitude, c.latitude] as [number, number], zoom: FOLLOW_ZOOM }
      : { center: [OLD_MAIN_LNG, OLD_MAIN_LAT] as [number, number], zoom: START_ZOOM }
  }

  useEffect(() => {
    const c = position?.coords
    if (!map || followed.current || !c || !insideBounds(bounds, c.latitude, c.longitude)) return
    followed.current = true
    map.easeTo({ center: [c.longitude, c.latitude], zoom: FOLLOW_ZOOM, pitch: PITCH, bearing: BEARING, duration: 1200 })
  }, [map, position, bounds])

  return (
    <button
      type="button"
      className="map-fab map-recenter"
      aria-label="Recenter"
      onClick={() => map?.easeTo({ ...target(), pitch: PITCH, bearing: BEARING, duration: 900 })}
    >
      <LocateIcon size={22} />
    </button>
  )
}

export default CampusMap
