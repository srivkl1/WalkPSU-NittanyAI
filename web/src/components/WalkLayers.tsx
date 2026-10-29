import type { ExpressionSpecification } from 'maplibre-gl'
import type { FeatureCollection, LineString, MultiLineString } from 'geojson'
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import { Layer, Source, useMap } from 'react-map-gl/maplibre'
import { hexFeatures } from '../map/hexgrid'
import { useDiscovery } from '../session/discovery'
import { useReadySession } from '../session/session'
import { useTrails, type TrailPoint } from '../session/trail'

const FOG_COLOR = '#8b9099'
const FOG_OPACITY = 0.32
const REVEAL_MS = 1600
/** The fog sits under the building glow, so everything above it (claim circles, drops, trails, sprites) stays clear. */
const FOG_BELOW = 'buildings-active-glow'
/** Drawn trail is capped for rendering; the distance in Profile still uses every point. */
const MAX_DRAWN_POINTS = 1500
const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] }

/** Rounds the corners of a GPS polyline (two passes of Chaikin), so the trail reads as a path, not a zigzag. */
function smooth(points: TrailPoint[]): TrailPoint[] {
  let out = points
  for (let pass = 0; pass < 2 && out.length > 2; pass++) {
    const next: TrailPoint[] = [out[0]]
    for (let i = 0; i < out.length - 1; i++) {
      const [x0, y0] = out[i]
      const [x1, y1] = out[i + 1]
      next.push([0.75 * x0 + 0.25 * x1, 0.75 * y0 + 0.25 * y1], [0.25 * x0 + 0.75 * x1, 0.25 * y0 + 0.75 * y1])
    }
    next.push(out[out.length - 1])
    out = next
  }
  return out
}

const rgba = (hex: string, alpha: number) => {
  const n = parseInt(hex.replace('#', ''), 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
}

const zoomWidth = (atZ14: number, atZ18: number): ExpressionSpecification => ['interpolate', ['linear'], ['zoom'], 14, atZ14, 18, atZ18]

/** Fog of war over undiscovered campus areas, my trail, and other players' short tails. */
function WalkLayers() {
  const { player } = useReadySession()
  const { segments, tails } = useTrails()
  const { areas, discovered, justDiscovered, showFog } = useDiscovery()

  const fog = useMemo(() => hexFeatures(areas.filter((id) => !discovered.has(id))), [areas, discovered])

  // The segment I'm walking now fades from me back to its start; older segments (before a GPS jump) stay faint.
  const current = useMemo<FeatureCollection<LineString>>(() => {
    const now = segments.at(-1)
    if (!now || now.length < 2) return EMPTY as FeatureCollection<LineString>
    return { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: smooth(now.slice(-MAX_DRAWN_POINTS)) } }] }
  }, [segments])
  const earlier = useMemo<FeatureCollection<MultiLineString>>(
    () => ({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', properties: {}, geometry: { type: 'MultiLineString', coordinates: segments.slice(0, -1).filter((s) => s.length > 1).map(smooth) } }],
    }),
    [segments],
  )
  const others = useMemo<FeatureCollection<LineString>>(
    () => ({
      type: 'FeatureCollection',
      features: tails
        .filter((t) => t.points.length > 1)
        .map((t) => ({ type: 'Feature', properties: { color: t.color }, geometry: { type: 'LineString', coordinates: smooth(t.points) } })),
    }),
    [tails],
  )

  const gradient = useMemo<ExpressionSpecification>(
    () => ['interpolate', ['linear'], ['line-progress'], 0, rgba(player.color, 0), 0.5, rgba(player.color, 0.45), 1, rgba(player.color, 0.9)],
    [player.color],
  )
  const fogVisibility = showFog ? 'visible' : 'none'
  // CampusMap's layers and these can reach the map in either order once the style loads; adding the fog "before" a
  // layer that isn't there yet throws and leaves no fog. Placed by beforeId, the fog lands in the same spot whenever
  // it mounts, so waiting for its anchor is safe (unlike the trails below, which must mount in JSX order).
  const anchored = useHasLayer(FOG_BELOW)

  return (
    <>
      {anchored && (
        <>
          <Source id="fog" type="geojson" data={fog}>
            {/* No antialiasing: neighboring hexes share edges, and AA would draw faint seams between them. */}
            <Layer
              id="fog"
              type="fill"
              beforeId={FOG_BELOW}
              layout={{ visibility: fogVisibility }}
              paint={{ 'fill-color': FOG_COLOR, 'fill-opacity': FOG_OPACITY, 'fill-antialias': false }}
            />
          </Source>
          <Source id="fog-reveal" type="geojson" data={EMPTY}>
            <Layer id="fog-reveal" type="fill" beforeId={FOG_BELOW} layout={{ visibility: fogVisibility }} paint={{ 'fill-color': FOG_COLOR, 'fill-opacity': 0, 'fill-antialias': false }} />
          </Source>
        </>
      )}
      <FogReveal hexId={justDiscovered} />

      <Source id="tails" type="geojson" data={others}>
        <Layer
          id="tails"
          type="line"
          layout={{ 'line-cap': 'round', 'line-join': 'round' }}
          paint={{ 'line-color': ['get', 'color'], 'line-width': zoomWidth(2, 4), 'line-opacity': 0.28 }}
        />
      </Source>
      <Source id="my-trail-earlier" type="geojson" data={earlier}>
        <Layer
          id="my-trail-earlier"
          type="line"
          layout={{ 'line-cap': 'round', 'line-join': 'round' }}
          paint={{ 'line-color': player.color, 'line-width': zoomWidth(2.5, 5), 'line-opacity': 0.18 }}
        />
      </Source>
      {/* line-gradient needs lineMetrics on the source. */}
      <Source id="my-trail" type="geojson" data={current} lineMetrics>
        <Layer id="my-trail" type="line" layout={{ 'line-cap': 'round', 'line-join': 'round' }} paint={{ 'line-width': zoomWidth(3, 6), 'line-gradient': gradient }} />
      </Source>
    </>
  )
}

/** True once the map has layer `id`; re-checked on every style change (adding a layer is one). */
function useHasLayer(id: string) {
  const { current: ref } = useMap()
  const map = ref?.getMap()
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!map) return () => {}
      map.on('styledata', onChange)
      return () => {
        map.off('styledata', onChange)
      }
    },
    [map],
  )
  return useSyncExternalStore(subscribe, () => !!map?.getLayer(id))
}

/** Fades a just-discovered hex's fog out: show it at full fog, then let a paint transition take it to zero. */
function FogReveal({ hexId }: { hexId: string | null }) {
  const { current: ref } = useMap()
  useEffect(() => {
    const map = ref?.getMap()
    const source = map?.getSource('fog-reveal') as { setData: (data: FeatureCollection) => void } | undefined
    if (!map || !source || !map.getLayer('fog-reveal') || !hexId || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    source.setData(hexFeatures([hexId]))
    map.setPaintProperty('fog-reveal', 'fill-opacity-transition', { duration: 0, delay: 0 })
    map.setPaintProperty('fog-reveal', 'fill-opacity', FOG_OPACITY)
    const frame = requestAnimationFrame(() => {
      map.setPaintProperty('fog-reveal', 'fill-opacity-transition', { duration: REVEAL_MS, delay: 0 })
      map.setPaintProperty('fog-reveal', 'fill-opacity', 0)
    })
    return () => cancelAnimationFrame(frame)
  }, [ref, hexId])
  return null
}

export default WalkLayers
