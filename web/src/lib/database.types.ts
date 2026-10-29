// Hand-written to match supabase/migrations. Keep in sync with every migration.
// (Or regenerate: npx supabase gen types typescript --project-id <id> > src/lib/database.types.ts)

/**
 * Mini-games and photo hunts were removed (20261029000000_remove_games_and_points.sql). Their old rows are expired and
 * never read, and the old game tables and hunt columns are left out here.
 */
export type DropType = 'checkin' | 'meetup'
export type DropStatus = 'active' | 'claimed' | 'expired'

type Player = {
  id: string
  auth_id: string
  display_name: string
  /** Server-assigned map color. */
  color: string
  is_admin: boolean
  created_at: string
}

type Drop = {
  id: string
  title: string
  type: DropType
  lat: number
  lng: number
  /** Left over from the points system; unused. */
  points: number
  status: DropStatus
  hint_photo_url: string | null
  building_num: string | null
  created_by: string | null
  created_at: string
  expires_at: string | null
  /** Shown under the title, e.g. the hosting organization of an imported campus event. */
  subtitle: string | null
  /** When the event behind the drop begins. null for drops made in /admin. */
  starts_at: string | null
  /** Set only on drops seeded from campus events (e.g. 'discover:12893409'), so they can be cleared. */
  source_id: string | null
}

/** A check-in at a drop: one per player per drop. (`points` is left over from the points system and unused.) */
type Claim = { id: string; drop_id: string; player_id: string; points: number; created_at: string }

type DropSecret = { drop_id: string; claim_code: string }

/** A Penn State Discover listing, kept fresh by /api/sync-events. `building` is null for online and off-campus events. */
export type DiscoverEventRow = {
  id: string
  title: string
  organization: string | null
  theme: string | null
  categories: string[]
  /** Discover's perks, e.g. "Free Food", "Free Stuff". */
  benefits: string[]
  starts_at: string
  ends_at: string
  location: string | null
  building: { num: string; name: string; lat: number; lng: number; matched_by: string } | null
  cancelled: boolean
  synced_at: string
}
/** Interest ids are INTERESTS' in lib/interests.ts (the migration checks the same list). */
export type PlayerProfile = { player_id: string; major: string | null; interests: string[]; updated_at: string }
/** Gemini's building for a free-text event location. `building_num` null: not a campus building. Server only. */
type DiscoverLocation = { location: string; building_num: string | null; checked_at: string }

/** A club is a Discover organization. Approved by an admin through decide_organizer_request. */
export type ClubOrganizer = { organization: string; player_id: string; approved_at: string }
export type OrganizerRequest = {
  id: string
  organization: string
  player_id: string
  note: string | null
  status: 'pending' | 'approved' | 'declined'
  created_at: string
  decided_at: string | null
}

/** One of a club's events on its dashboard: counts only, never who. */
export type ClubEvent = Pick<DiscoverEventRow, 'id' | 'title' | 'starts_at' | 'ends_at' | 'cancelled' | 'location' | 'building'> & {
  going: number
  checked_in: number
}
/** club_stats(): events from the last 90 days and every upcoming one (newest first), and club totals. */
export type ClubStats = {
  organization: string
  events: ClubEvent[]
  /** Players who checked in to any of the club's events. */
  attendees: number
  /** Of those, players who checked in to two or more. */
  returning: number
  rsvps: number
  checkins: number
}

type OwnRow = { event_id: string; player_id: string; created_at: string }

export type Database = {
  public: {
    Tables: {
      players: {
        Row: Player
        Insert: Pick<Player, 'display_name'>
        Update: Partial<Pick<Player, 'display_name'>>
        Relationships: []
      }
      drops: {
        Row: Drop
        Insert: Pick<Drop, 'title' | 'type' | 'lat' | 'lng'> &
          Partial<Pick<Drop, 'status' | 'hint_photo_url' | 'building_num' | 'created_by' | 'expires_at' | 'subtitle' | 'starts_at' | 'source_id'>>
        Update: Partial<Omit<Drop, 'id' | 'created_at'>>
        Relationships: []
      }
      claims: { Row: Claim; Insert: never; Update: never; Relationships: [] }
      drop_secrets: { Row: DropSecret; Insert: never; Update: never; Relationships: [] }
      /** Fog-of-war: hexes (web/src/map/hexgrid.ts ids, "q:r") a player has walked into. Own rows only. */
      discovered_areas: { Row: { player_id: string; hex_id: string }; Insert: { player_id: string; hex_id: string }; Update: never; Relationships: [] }
      /** Readable by players; written only by sync_discover_events. */
      discover_events: { Row: DiscoverEventRow; Insert: never; Update: never; Relationships: [] }
      /** Service role only. */
      discover_locations: { Row: DiscoverLocation; Insert: DiscoverLocation; Update: Partial<DiscoverLocation>; Relationships: [] }
      /** Major and interests. Private: a player reads and writes only their own. */
      player_profiles: { Row: PlayerProfile; Insert: Omit<PlayerProfile, 'updated_at'>; Update: Partial<Omit<PlayerProfile, 'player_id'>>; Relationships: [] }
      /** A player's own RSVPs only (RLS); written through set_going. */
      event_rsvps: { Row: OwnRow; Insert: never; Update: never; Relationships: [] }
      /** A player's own event check-ins only (RLS); written through check_in_event and drop check-ins. */
      event_checkins: { Row: OwnRow; Insert: never; Update: never; Relationships: [] }
      /** Own rows, or all of them for admins. */
      club_organizers: { Row: ClubOrganizer; Insert: never; Update: never; Relationships: [] }
      /** Own rows, or all of them for admins. */
      organizer_requests: { Row: OrganizerRequest; Insert: never; Update: never; Relationships: [] }
    }
    Views: Record<string, never>
    Functions: {
      /** Check in at a drop (GPS or QR). Once per player; the drop stays open. */
      claim_drop: { Args: { p_drop_id: string; p_lat?: number; p_lng?: number; p_code?: string }; Returns: Claim }
      claim_radius_m: { Args: Record<string, never>; Returns: number }
      current_player_id: { Args: Record<string, never>; Returns: string | null }
      /** Any player: a social pin at their position. Replaces their previous live meetup. */
      create_meetup: { Args: { p_text: string; p_lat: number; p_lng: number; p_minutes?: number; p_building_num?: string | null }; Returns: Drop }
      /** Admins: any drop. Players: a meetup they started. Marks it expired; its check-ins stay. */
      close_drop: { Args: { p_drop_id: string }; Returns: undefined }
      /** AI event search allowance (10 per 10 minutes); true if this search may run. Called by /api/search-events. */
      use_search_quota: { Args: Record<string, never>; Returns: boolean }
      /** How many players are going to each event (up to 100 ids), and whether the caller is. Never who. */
      event_going: { Args: { p_event_ids: string[] }; Returns: { event_id: string; going: number; me: boolean }[] }
      /** The caller's RSVP on or off; returns the new going count. */
      set_going: { Args: { p_event_id: string; p_going: boolean }; Returns: number }
      /** Check in to an event (QR code, or GPS at its building). True on the first check-in. */
      check_in_event: { Args: { p_event_id: string; p_lat?: number; p_lng?: number; p_code?: string }; Returns: boolean }
      /** "I run this club." Returns the waiting request (the same one if asked again). */
      request_organizer: { Args: { p_organization: string; p_note?: string | null }; Returns: OrganizerRequest }
      /** Admins only. */
      decide_organizer_request: { Args: { p_request_id: string; p_approve: boolean }; Returns: OrganizerRequest }
      /** Organizers of the event's club (and admins): its door QR code. */
      event_checkin_code: { Args: { p_event_id: string }; Returns: string }
      /** Organizers of the club (and admins). Counts only. */
      club_stats: { Args: { p_organization: string }; Returns: ClubStats }
      runs_club: { Args: { p_organization: string }; Returns: boolean }
      /** Service role only. p_complete: the fetch got every listing, so missing upcoming events count as cancelled. */
      sync_discover_events: {
        Args: { p_events: Record<string, unknown>[]; p_complete: boolean }
        Returns: { events: number; cancelled: number; drops_rescheduled: number; drops_closed: number }
      }
      /** True if the area is new for the caller, false if already discovered. */
      discover_area: { Args: { p_hex_id: string }; Returns: boolean }
      is_admin: { Args: Record<string, never>; Returns: boolean }
    }
    Enums: { drop_type: DropType; drop_status: DropStatus }
    CompositeTypes: Record<string, never>
  }
}

type PublicTables = Database['public']['Tables']
export type PlayerRow = PublicTables['players']['Row']
export type DropRow = PublicTables['drops']['Row']
export type NewDrop = PublicTables['drops']['Insert']
export type ClaimRow = PublicTables['claims']['Row']
