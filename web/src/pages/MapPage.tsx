import type { FeatureCollection, Point, Polygon } from 'geojson'
import { useEffect, useMemo, useState } from 'react'
import { Layer, Popup, Source, useMap, type MapLayerMouseEvent } from 'react-map-gl/maplibre'
import Avatar from '../components/Avatar'
import CampusMap from '../components/CampusMap'
import DropSheet from '../components/DropSheet'
import EventSheet from '../components/EventSheet'
import { CrossIcon, InfoIcon, PlusIcon, SearchIcon } from '../components/icons'
import MapKeySheet from '../components/MapKeySheet'
import MeetupSheet from '../components/MeetupSheet'
import FoundOverlay, { type Found } from '../components/FoundOverlay'
import PlayerSprite from '../components/PlayerSprite'
import SearchSheet from '../components/SearchSheet'
import WalkLayers from '../components/WalkLayers'
import type { EventResult } from '../lib/api'
import { DROP_TYPES, eventTheme } from '../lib/campus'
import type { DropRow } from '../lib/database.types'
import { distanceM } from '../lib/geo'
import { useBuildings, useClaimRadius, useDrops, useUpcomingEvents } from '../lib/hooks'
import { LABEL_FONT } from '../map/basemap'
import { circlePolygon } from '../map/geometry'
import { usePresence, type LivePlayer } from '../session/presence'
import { useReadySession } from '../session/session'

const IN_RANGE = '#16a34a'
/** A photo hunt's pin once someone has found it. */
const REVEALED = '#dc2626'
/** How close a tapped drop is framed: about a block across, so its claim circle and building are both visible. */
const DROP_ZOOM = 17

/** A photo hunt nobody has found yet: its lat/lng is only the center of a search circle, so it gets no pin. */
const isHiddenHunt = (d: DropRow) => d.type === 'photo_hunt' && !d.first_found_at
const SHEET_CLOSE_MS = 500

type MapInstance = MapLayerMouseEvent['target']

/**
 * Lifts a point into the top half of the screen, clear of a bottom sheet, zooming in if the player was zoomed out
 * (never out, if they were closer). A longer glide when it zooms, so the jump reads as one move.
 */
function glideTo(map: MapInstance, lng: number, lat: number) {
  const zoom = Math.max(map.getZoom(), DROP_ZOOM)
  const zooming = zoom - map.getZoom() > 0.25
  map.easeTo({ center: [lng, lat], zoom, offset: [0, -170], duration: zooming ? 800 : 450 })
}

/** Glides the map to `target` each time it changes (for things picked outside the map, like search results). */
function FlyTo({ target }: { target: { lng: number; lat: number } | null }) {
  const { current: map } = useMap()
  useEffect(() => {
    if (map && target) glideTo(map.getMap(), target.lng, target.lat)
  }, [map, target])
  return null
}
/** Layers whose features open a drop's sheet. Pins come first so they win over the circle underneath. */
const DROP_LAYERS = ['drop-points', 'hunt-centers', 'hunt-areas']
/** Tappable layers, drops first: a drop pin wins over an event pin it overlaps. */
const TAPPABLE = [...DROP_LAYERS, 'event-points']
/** "Also here" in an event's card: enough to show a building is busy without burying the map. */
const MAX_ALSO_HERE = 5
const pinColor = (d: DropRow) => (d.type === 'photo_hunt' ? REVEALED : DROP_TYPES[d.type].color)

function MapPage() {
  const { data: drops, error, refresh: refreshDrops } = useDrops()
  const { data: upcoming } = useUpcomingEvents()
  const buildings = useBuildings()
  const radius = useClaimRadius()
  const { position, others } = usePresence()
  const { player } = useReadySession()
  const [selectedPlayerId, setSelectedPlayerId] = useState<string | null>(null)
  // The sheet keeps its drop while it slides away, so closing never flashes empty content.
  const [sheet, setSheet] = useState<{ drop: DropRow; open: boolean } | null>(null)
  const [found, setFound] = useState<Found | null>(null)
  const [composing, setComposing] = useState(false)
  const [searching, setSearching] = useState(false)
  const [showingKey, setShowingKey] = useState(false)
  // A searched event's card; like `sheet`, it keeps its event while sliding away.
  const [event, setEvent] = useState<{ event: EventResult; open: boolean } | null>(null)
  const [flyTarget, setFlyTarget] = useState<{ lng: number; lat: number } | null>(null)
  // Set while a search narrows the map to the drops Gemini picked.
  const [filter, setFilter] = useState<{ query: string; ids: ReadonlySet<string> } | null>(null)

  const here = position?.coords
  const distanceTo = (d: DropRow) => (here ? distanceM(here.latitude, here.longitude, d.lat, d.lng) : null)
  const shown = useMemo(() => (filter ? drops.filter((d) => filter.ids.has(d.id)) : drops), [drops, filter])
  // Buildings with a shown drop glow; so does the building of the searched event on screen.
  const eventBuilding = event?.open ? event.event.building?.num : undefined
  const highlighted = useMemo(
    () => new Set([...shown.flatMap((d) => (d.building_num ? [d.building_num] : [])), ...(eventBuilding ? [eventBuilding] : [])]),
    [shown, eventBuilding],
  )
  const buildingNames = useMemo(() => new Map(buildings.map((b) => [b.properties.num, b.properties.name])), [buildings])
  // All search sends about a drop: its title and building, never its location.
  const searchable = useMemo(
    () => drops.map((d) => ({ id: d.id, title: d.title, ...(d.building_num && buildingNames.has(d.building_num) && { at: buildingNames.get(d.building_num) }) })),
    [drops, buildingNames],
  )

  const circles = useMemo<FeatureCollection<Polygon>>(
    () => ({
      type: 'FeatureCollection',
      features:
        radius === null
          ? []
          : // Meetups aren't claimable, so they get a pin but no claim circle.
            shown.filter((d) => !isHiddenHunt(d) && d.type !== 'meetup').map((d) => {
              const distance = here ? distanceM(here.latitude, here.longitude, d.lat, d.lng) : null
              return {
                type: 'Feature',
                properties: { color: pinColor(d), inRange: distance !== null && distance <= radius },
                geometry: circlePolygon(d.lat, d.lng, radius),
              }
            }),
    }),
    [shown, radius, here],
  )
  const huntAreas = useMemo<FeatureCollection<Polygon>>(
    () => ({
      type: 'FeatureCollection',
      features: shown
        .filter(isHiddenHunt)
        .map((d) => ({ type: 'Feature', properties: { id: d.id }, geometry: circlePolygon(d.lat, d.lng, d.search_radius_m ?? 125) })),
    }),
    [shown],
  )
  // A "?" pin at each search circle's center. That point is already the public decoy center, never the real spot.
  const huntCenters = useMemo<FeatureCollection<Point>>(
    () => ({
      type: 'FeatureCollection',
      features: shown.filter(isHiddenHunt).map((d) => ({ type: 'Feature', properties: { id: d.id }, geometry: { type: 'Point', coordinates: [d.lng, d.lat] } })),
    }),
    [shown],
  )
  const dropPoints = useMemo<FeatureCollection<Point>>(
    () => ({
      type: 'FeatureCollection',
      features: shown
        .filter((d) => !isHiddenHunt(d))
        .map((d) => ({ type: 'Feature', properties: { id: d.id, color: pinColor(d) }, geometry: { type: 'Point', coordinates: [d.lng, d.lat] } })),
    }),
    [shown],
  )
  // Campus events in the next week (useUpcomingEvents), by building. An event that is also a seeded drop shows as that drop instead.
  const eventsByBuilding = useMemo(() => {
    const seeded = new Set(drops.flatMap((d) => (d.source_id?.startsWith('discover:') ? [d.source_id.slice('discover:'.length)] : [])))
    const byNum = new Map<string, EventResult[]>()
    for (const e of upcoming) {
      if (!e.building || seeded.has(e.id)) continue
      byNum.set(e.building.num, [...(byNum.get(e.building.num) ?? []), e])
    }
    return byNum
  }, [upcoming, drops])
  const eventBuildings = useMemo(() => new Set(eventsByBuilding.keys()), [eventsByBuilding])
  // One pin per building, in the color of its soonest event's type.
  const eventPoints = useMemo<FeatureCollection<Point>>(
    () => ({
      type: 'FeatureCollection',
      features: [...eventsByBuilding].map(([num, events]) => ({
        type: 'Feature',
        properties: { num, color: eventTheme(events[0].theme).color },
        geometry: { type: 'Point', coordinates: [events[0].building!.lng, events[0].building!.lat] },
      })),
    }),
    [eventsByBuilding],
  )
  // Everyone on the map as sprites; me last so my sprite draws on top.
  const sprites = useMemo<LivePlayer[]>(
    () => [
      ...others,
      ...(here ? [{ playerId: player.id, name: player.display_name, color: player.color, lat: here.latitude, lng: here.longitude }] : []),
    ],
    [others, here, player],
  )

  const closeSheet = () => setSheet((s) => s && { ...s, open: false })
  const closeEvent = () => setEvent((s) => s && { ...s, open: false })

  /** Seeded drops carry their Discover event id, so a search result can open the drop players can claim. */
  const dropForEvent = (eventId: string) => drops.find((d) => d.source_id === `discover:${eventId}`)

  const pickDrop = (drop: DropRow) => {
    setSearching(false)
    setTimeout(() => {
      closeEvent()
      setSheet({ drop, open: true })
      setFlyTarget({ lng: drop.lng, lat: drop.lat })
    }, SHEET_CLOSE_MS)
  }

  const pickEvent = (result: EventResult, drop: DropRow | undefined) => {
    setSearching(false)
    // After the search sheet has slid away (Vaul's close takes 0.5 s), so the sheets don't overlap.
    setTimeout(() => {
      closeSheet()
      closeEvent()
      if (drop) {
        setSheet({ drop, open: true })
        setFlyTarget({ lng: drop.lng, lat: drop.lat })
      } else {
        setEvent({ event: result, open: true })
        if (result.building) setFlyTarget({ lng: result.building.lng, lat: result.building.lat })
      }
    }, SHEET_CLOSE_MS)
  }

  const onClick = (e: MapLayerMouseEvent) => {
    const hit = e.features?.[0]
    const id = hit?.properties?.id as string | undefined
    // An unfound photo hunt is tapped through its "?" pin or its search circle; its lat/lng is that circle's center.
    const drop = hit && DROP_LAYERS.includes(hit.layer.id) ? drops.find((d) => d.id === id) : undefined
    const events = hit?.layer.id === 'event-points' ? eventsByBuilding.get(hit.properties?.num as string) : undefined
    closeEvent()
    if (events?.length) {
      closeSheet()
      setSelectedPlayerId(null)
      setEvent({ event: events[0], open: true })
      glideTo(e.target, events[0].building!.lng, events[0].building!.lat)
    } else if (drop) {
      setSelectedPlayerId(null)
      setSheet({ drop, open: true })
      glideTo(e.target, drop.lng, drop.lat)
    } else {
      closeSheet()
      setSelectedPlayerId(null)
    }
  }

  // Track the live row; a drop that vanishes (claimed, expired) closes its sheet.
  const sheetDrop = sheet && (drops.find((d) => d.id === sheet.drop.id) ?? sheet.drop)
  const sheetOpen = !!sheet?.open && drops.some((d) => d.id === sheet.drop.id)
  const selectedPlayer = selectedPlayerId ? sprites.find((p) => p.playerId === selectedPlayerId) : undefined

  return (
    <div className="map-wrap">
      <CampusMap buildings={buildings} highlighted={highlighted} tinted={eventBuildings} className="map" interactiveLayerIds={TAPPABLE} onClick={onClick}>
        {/* First, so trails draw under drops and claim circles; the fog places itself under the building glow. */}
        <WalkLayers />
        <FlyTo target={flyTarget} />
        {/* Under every drop layer: events are background, drops are the game. */}
        <Source id="events" type="geojson" data={eventPoints}>
          <Layer
            id="event-points"
            type="circle"
            paint={{ 'circle-radius': 9, 'circle-color': ['get', 'color'], 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2.5 }}
          />
        </Source>
        <Source id="hunt-areas" type="geojson" data={huntAreas}>
          <Layer id="hunt-areas" type="fill" paint={{ 'fill-color': DROP_TYPES.photo_hunt.color, 'fill-opacity': 0.14 }} />
          <Layer id="hunt-areas-line" type="line" paint={{ 'line-color': DROP_TYPES.photo_hunt.color, 'line-width': 2.5, 'line-dasharray': [1, 2] }} />
        </Source>
        <Source id="claim-circles" type="geojson" data={circles}>
          <Layer
            id="claim-circles-fill"
            type="fill"
            paint={{ 'fill-color': ['case', ['get', 'inRange'], IN_RANGE, ['get', 'color']], 'fill-opacity': ['case', ['get', 'inRange'], 0.25, 0.08] }}
          />
          <Layer id="claim-circles-out" type="line" filter={['!', ['get', 'inRange']]} paint={{ 'line-color': ['get', 'color'], 'line-width': 1.5, 'line-dasharray': [3, 3] }} />
          <Layer id="claim-circles-in" type="line" filter={['get', 'inRange']} paint={{ 'line-color': IN_RANGE, 'line-width': 3 }} />
        </Source>
        <Source id="drops" type="geojson" data={dropPoints}>
          <Layer
            id="drop-points"
            type="circle"
            paint={{ 'circle-radius': 11, 'circle-color': ['get', 'color'], 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 3 }}
          />
        </Source>
        <Source id="hunt-centers" type="geojson" data={huntCenters}>
          <Layer
            id="hunt-centers"
            type="circle"
            paint={{ 'circle-radius': 11, 'circle-color': DROP_TYPES.photo_hunt.color, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 3 }}
          />
          <Layer
            id="hunt-centers-mark"
            type="symbol"
            layout={{ 'text-field': '?', 'text-font': LABEL_FONT, 'text-size': 14, 'text-allow-overlap': true, 'text-ignore-placement': true }}
            paint={{ 'text-color': '#ffffff' }}
          />
        </Source>
        {sprites.map((p) => (
          <PlayerSprite
            key={p.playerId}
            id={p.playerId}
            name={p.name}
            color={p.color}
            lng={p.lng}
            lat={p.lat}
            me={p.playerId === player.id}
            onTap={() => {
              closeSheet()
              setSelectedPlayerId(p.playerId)
            }}
          />
        ))}

        {selectedPlayer && (
          <Popup longitude={selectedPlayer.lng} latitude={selectedPlayer.lat} anchor="bottom" offset={selectedPlayer.playerId === player.id ? 48 : 40} closeButton={false} onClose={() => setSelectedPlayerId(null)} className="map-card is-player">
            <span className="player-tag">
              <Avatar name={selectedPlayer.name} color={selectedPlayer.color} />
              <span className="truncate">{selectedPlayer.playerId === player.id ? `${selectedPlayer.name} (you)` : selectedPlayer.name}</span>
            </span>
          </Popup>
        )}
      </CampusMap>
      <div className="map-top">
        <button type="button" className="map-pill glass search-pill" onClick={() => setSearching(true)}>
          <SearchIcon size={18} />
          Find events you’d like…
        </button>
        <span className="map-pill glass" role="status">
          <span className="live-dot" data-off={shown.length === 0 || undefined} aria-hidden />
          {filter
            ? shown.length === 0
              ? `No drops match “${filter.query}”`
              : `Showing ${shown.length} of ${drops.length} · “${filter.query}”`
            : drops.length === 0
              ? 'No live drops'
              : `${drops.length} live ${drops.length === 1 ? 'drop' : 'drops'}`}
          {filter && (
            <button type="button" className="pill-clear" aria-label="Show all drops" onClick={() => setFilter(null)}>
              <CrossIcon size={14} />
            </button>
          )}
        </span>
        {error && <div className="map-banner glass error">{error}</div>}
      </div>
      <button
        type="button"
        className="glass map-info"
        aria-label="Map key"
        onClick={() => {
          // An open card would show through the key's glass.
          closeSheet()
          closeEvent()
          setShowingKey(true)
        }}
      >
        <InfoIcon size={22} />
      </button>
      <MapKeySheet open={showingKey} onOpenChange={setShowingKey} />
      <button type="button" className="map-pill glass meetup-fab" onClick={() => setComposing(true)}>
        <PlusIcon size={18} />
        Meetup
      </button>
      <SearchSheet
        open={searching}
        onOpenChange={setSearching}
        drops={searchable}
        dropById={(id) => drops.find((d) => d.id === id)}
        dropFor={dropForEvent}
        onMatched={(query, ids) => {
          closeSheet()
          // Narrow the map only when some live drop fits. A search that only found campus events (or nothing) leaves
          // every drop on the map, instead of emptying it.
          setFilter(ids.length > 0 ? { query, ids: new Set(ids) } : null)
        }}
        onPick={pickEvent}
        onPickDrop={pickDrop}
      />
      <EventSheet
        event={event?.event ?? null}
        open={!!event?.open}
        onClose={closeEvent}
        more={(event?.event.building ? (eventsByBuilding.get(event.event.building.num) ?? []) : []).filter((e) => e.id !== event?.event.id).slice(0, MAX_ALSO_HERE)}
        onSelect={(other) => setEvent({ event: other, open: true })}
      />
      <MeetupSheet
        open={composing}
        onOpenChange={setComposing}
        onCreated={(drop) => {
          setComposing(false)
          refreshDrops()
          // Show the new meetup once the composer has slid away (Vaul's close takes 0.5 s), so the sheets don't overlap.
          setTimeout(() => setSheet({ drop, open: true }), SHEET_CLOSE_MS)
        }}
      />
      <DropSheet
        drop={sheetDrop}
        open={sheetOpen}
        distance={sheetDrop ? distanceTo(sheetDrop) : null}
        radius={radius}
        position={position}
        onClose={closeSheet}
        onClaimed={() => {
          closeSheet()
          refreshDrops()
        }}
        onCleared={() => {
          closeSheet()
          refreshDrops()
        }}
        onFound={(points, reason) => {
          if (!sheetDrop) return
          // Only the first finder gets full points; the map's copy of the drop may be a moment stale.
          setFound({ title: sheetDrop.title, points, first: points === sheetDrop.points && !sheetDrop.first_found_at, reason })
          closeSheet()
          refreshDrops()
        }}
      />
      {found && <FoundOverlay found={found} onClose={() => setFound(null)} />}
    </div>
  )
}

export default MapPage
