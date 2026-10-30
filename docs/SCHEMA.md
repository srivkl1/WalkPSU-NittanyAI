# Schema

Source of truth: the files in `supabase/migrations/`, applied in order. TypeScript mirror: `web/src/lib/database.types.ts`. Call everything through `web/src/lib/api.ts`.

There are no teams, points, or games in the data model anymore. Teams went in `20261024020000_individual_players.sql`, building capture in `20261024040000_remove_building_capture.sql`, and mini-games, photo hunts, and points in `20261029000000_remove_games_and_points.sql`. A drop is now a check-in or a meetup, and a check-in counts as attendance.

## Identity

Every request carries a JWT. Its `sub` claim is the user's id: the Auth0 user id (`auth0|abc…`) or, in fallback mode, the Supabase anonymous user id. `players.auth_id` stores that `sub`, and the database fills it in automatically on insert. You never send it.

A user is an **admin** if either:

- the Auth0 ID token has `app_role: "admin"` (set by the Auth0 Action from the user's Auth0 roles), or
- their `players.is_admin` is `true` (set by hand in the Supabase dashboard; this is how admins work in fallback mode).

A player is an **organizer** of a club once an admin approves their request (`club_organizers`). Admins can do everything an organizer can, for every club.

## Tables

### `players`

| column | type | notes |
| --- | --- | --- |
| `id` | uuid | |
| `auth_id` | text | JWT `sub`, unique, set by the database |
| `display_name` | text | 1–32 chars |
| `color` | text | hex map color, server-assigned on insert (least-used color of a 12-color palette) |
| `is_admin` | boolean | default false |
| `created_at` | timestamptz | |

Every signed-in user can read all players. A player can insert and update only their own row, and only `display_name`. `color` and `is_admin` can't be written by clients.

### `drops`

| column | type | notes |
| --- | --- | --- |
| `id` | uuid | |
| `title` | text | |
| `type` | `checkin` \| `meetup` | `meetup` = a player's social pin from `create_meetup`. The enum still holds `minigame` and `photo_hunt` for old rows; a trigger refuses new ones |
| `lat`, `lng` | double precision | |
| `points` | integer | unused, left from the points system (default 10) |
| `status` | `active` \| `claimed` \| `expired` | default `active`. Check-ins stay `active` as people check in; `claimed` appears only on old rows |
| `hint_photo_url` | text | optional photo, public URL in the `drop-hints` storage bucket |
| `building_num` | text | PSU building number (`num` in `buildings.geojson`). null = open-ground drop. The map highlights a building while it hosts an active drop |
| `created_by` | uuid → `players` | |
| `created_at` | timestamptz | |
| `expires_at` | timestamptz | null = until cleared. Past this time nobody can check in even if `status` is still `active` |
| `subtitle` | text | optional line under the title; the hosting organization for imported campus events |
| `starts_at` | timestamptz | optional; when the event behind the drop begins. The drop card shows it with `expires_at` |
| `source_id` | text | unique. Set only on drops seeded from campus events (`discover:<event id>`, by `web/scripts/seed-event-drops.mjs`); null for drops made in `/admin` |

Old columns from photo hunts and mini-games (`twist`, `search_radius_m`, `first_found_at`, `game`) are still there, unread. Only admins can insert, update, or delete. Everyone signed in can read.

### `claims` (check-ins at drops)

| column | type | notes |
| --- | --- | --- |
| `id` | uuid | |
| `drop_id` | uuid → `drops` | unique together with `player_id`: one check-in per player per drop |
| `player_id` | uuid → `players` | who checked in |
| `points` | integer | unused, left from the points system |
| `created_at` | timestamptz | |

Read-only for clients; rows come only from `claim_drop`. Old claims from games and photo hunts are kept. A check-in at a drop seeded from a campus event also checks the player in to that event (`event_checkins`, by a trigger).

### `drop_secrets`

| column | type | notes |
| --- | --- | --- |
| `drop_id` | uuid → `drops` | primary key |
| `claim_code` | text | 32-char random code encoded in the drop's QR |

Created automatically by a trigger when a drop is inserted. **Only admins can read it**; players never see codes except by scanning. The QR encodes `https://<app>/claim/<drop_id>?key=<claim_code>`. (Old photo hunts' hidden spots are in `hunt_lat`, `hunt_lng`, `hunt_building_num`.)

### Old game tables

`games`, `game_players`, `game_results`, and `campus_landmarks` hold old mini-game data. Nothing reads or writes them, and the functions that did were dropped.

### `discovered_areas` (fog of war)

| column | type | notes |
| --- | --- | --- |
| `player_id` | uuid | references `players`, cascade delete |
| `hex_id` | text | an area of the client's hex grid (`web/src/map/hexgrid.ts`): axial `"q:r"` from Old Main, 120 m edges. Checked against `^-?[0-9]{1,4}:-?[0-9]{1,4}$` |

Primary key `(player_id, hex_id)`. Deliberately **no timestamps or coordinates**, so it can't reconstruct where or when anyone walked. RLS: a player reads and inserts only their own rows (`player_id = current_player_id()`). No update or delete for anyone. Not in the Realtime publication.

### `discover_events` (live Penn State Discover listings)

| column | type | notes |
| --- | --- | --- |
| `id` | text PK | Discover's event id; a seeded drop points here with `source_id = 'discover:<id>'` |
| `title`, `organization`, `theme` | text | public listing facts only: no descriptions, organizer contacts, or attendees. `organization` is the club |
| `categories` | text[] | |
| `benefits` | text[] | Discover's `benefitNames` ("Free Food", "Free Stuff") |
| `starts_at`, `ends_at` | timestamptz | |
| `location` | text | as the organizer typed it |
| `building` | jsonb | `{ num, name, lat, lng, matched_by }` (`location text`, `coordinates`, or `gemini`); null for online events and ones away from University Park |
| `cancelled` | boolean | gone from a complete Discover fetch before it ended; cleared if it reappears |
| `synced_at` | timestamptz | |

Written only by `sync_discover_events`. RLS: signed-in players read every row; nobody writes. Events that ended over 30 days ago are pruned on each sync, **unless someone RSVP'd or checked in** (a club's history and second-visit rate need them). Not in the Realtime publication (search reads it per request).

### `player_profiles` (major and interests, private)

`player_id` (PK, references `players`, cascade delete), `major` (null, or 1–80 characters), `interests` (text[], each one of the ids in `web/src/lib/interests.ts`'s `INTERESTS`, enforced by a check constraint; keep the two lists in step), `updated_at`. RLS: a player reads, inserts, and updates **only their own row**; nobody deletes (clear the fields instead); anon has nothing. "For you" matching runs on the phone (`matchEvent`/`forYou`). The only other reader is `/api/club-insights`, which uses the service key to count how many profiles match a club's events and returns counts only.

### `event_rsvps` (WalkPSU's own "I'm going")

`event_id` (references `discover_events`, cascade delete), `player_id` (references `players`, cascade delete), `created_at`. Primary key `(event_id, player_id)`. RLS: a player reads only their own rows; no direct writes for anyone (`set_going` writes). Others see only counts, through `event_going` and `club_stats`, **never who is going**. Discover's own RSVP numbers (`rsvpTotal`) are deliberately not used.

### `event_checkins` (who came to a campus event)

`event_id` (references `discover_events`, cascade delete), `player_id` (references `players`, cascade delete), `created_at`. Primary key `(event_id, player_id)`: one per player per event. Written by `check_in_event` (the door QR code, or GPS at the building) and by a trigger when someone checks in at a drop seeded from the event. RLS: a player reads only their own rows; no direct writes. Organizers see counts only, through `club_stats`.

### `event_secrets` (door QR codes)

`event_id` (PK, references `discover_events`), `code` (32-char random). Made the first time an organizer opens the event's QR code. RLS on with no policies and no grants: only `event_checkin_code` and `check_in_event` touch it. The QR encodes `https://<app>/checkin/<event_id>?key=<code>`.

### `club_organizers` and `organizer_requests`

`club_organizers (organization, player_id, approved_at)`, primary key `(organization, player_id)`: who runs which club. `organizer_requests (id, organization, player_id, note ≤ 200 chars, status pending | approved | declined, created_at, decided_at)`, with at most one pending request per player per club. RLS on both: a player reads their own rows, admins read all; no direct writes (`request_organizer` and `decide_organizer_request` write).

### `discover_locations` (Gemini placement cache)

`location` (PK, lowercased with whitespace collapsed), `building_num` (null: Gemini said it isn't a campus building), `checked_at`. Service role only, so each free-text location costs one Gemini call ever. Players have no privileges on it.

## Functions

- **`claim_drop(p_drop_id, p_lat?, p_lng?, p_code?) → claims`**. Checks the caller in at a drop. Proof is either the drop's QR `p_code` (any distance) or a GPS position within `claim_radius_m()`. One check-in per player; the drop stays `active` for everyone else. It raises an error with a user-facing message when:
  - the caller hasn't joined,
  - the drop is a meetup (nothing to check in to), an old game or hunt, gone, or expired,
  - the code is wrong,
  - there's no code and no position,
  - there's no code and the caller is too far away,
  - the caller already checked in there.

  Client: `claimDrop(dropId, { lat, lng })` or `claimDrop(dropId, { code })`.
- **Meetups and clearing:**
  - `create_meetup(p_text, p_lat, p_lng, p_minutes = 60, p_building_num?) → drops`. Any joined player. Inserts a `meetup` drop titled with the trimmed text (3–80 characters), subtitle "Started by <name>", at the given position (must be within 5 km of Old Main), expiring after `p_minutes` clamped to 15–180. Posting again expires the player's previous live meetup, and a player can post at most 5 an hour. Client: `createMeetup(...)`.
  - `close_drop(p_drop_id)`. Admins may clear any drop; a player may end a meetup they started. Sets `status = 'expired'` (and `expires_at` to now), never deletes, so the drop's check-ins stay. Client: `closeDrop(dropId)`.
- **`discover_area(p_hex_id) → boolean`**. Records an area for the caller; `true` if new, `false` if they already had it (duplicates are ignored). Runs as the caller (`security invoker`), so the insert policy applies. The client calls it from `DiscoveryProvider` only on a GPS fix with accuracy ≤ 20 m inside one of the campus areas. Client: `discoverArea(hexId)`, `getDiscoveredAreas()`.
- **Event RSVPs:**
  - `event_going(p_event_ids text[]) → (event_id, going, me)[]`. Each listed event's going count and whether the caller is going (first 100 ids; unknown ids are left out). Counts only. Client: `getGoing(eventId)`.
  - `set_going(p_event_id, p_going) → integer`. Turns the caller's RSVP on or off and returns the new count. Going is refused for an event that's over or cancelled (or unknown, or before joining); un-RSVPing always works. Client: `setGoing(eventId, going)`.
- **Event check-ins and clubs** (`20261029010000_clubs.sql`):
  - `check_in_event(p_event_id, p_lat?, p_lng?, p_code?) → boolean`. Checks the caller in to a campus event with its door QR code (any distance) or GPS within `claim_radius_m()` of its building. Open from 30 minutes before the start until the end. Refused: not joined, unknown, cancelled, too early, over, a wrong code, no position, too far, or GPS for an event with no building. `true` the first time, `false` if already in. Client: `checkInEvent(eventId, proof)`.
  - `request_organizer(p_organization, p_note?) → organizer_requests`. "I run this club." The club must have events in `discover_events`. Asking again while a request waits returns it; an organizer can't ask again; at most 5 pending per player. Client: `requestOrganizer(organization, note)`.
  - `decide_organizer_request(p_request_id, p_approve) → organizer_requests`. Admins only, pending requests only. Approving adds the `club_organizers` row. Client: `decideOrganizerRequest(id, approve)`.
  - `runs_club(p_organization) → boolean`. The caller is an admin or an organizer of the club.
  - `event_checkin_code(p_event_id) → text`. The event's door QR code, made on first use. Organizers of the event's club and admins only. Client: `getEventCheckinCode(eventId)`.
  - `club_stats(p_organization) → jsonb`. Organizers of the club and admins only. `{ organization, events: [{ id, title, starts_at, ends_at, cancelled, location, building, going, checked_in }], attendees, returning, rsvps, checkins }`: events from the last 90 days and every upcoming one, newest first. `attendees` is players who checked in to any of the club's events, `returning` those who checked in to two or more (the second-visit rate is `returning / attendees`). **Counts only, never player ids or names.** Client: `getClubStats(organization)`.
- **`sync_discover_events(p_events jsonb, p_complete boolean) → { events, cancelled, drops_rescheduled, drops_closed }`**. **Service role only**, called by `/api/sync-events`. Upserts every listing in `p_events` (duplicate ids count once; `lat`/`lng` aren't stored). Only when `p_complete` (the fetch got every page) does an upcoming event missing from the batch become `cancelled`, so a truncated fetch never cancels anything. Seeded drops follow their event: an `active` drop gets the event's new `starts_at`/`expires_at`, and a cancelled event's active drop is closed like `close_drop` (`status = 'expired'`, never deleted, so its check-ins stay). A drop that's already closed stays closed. Prunes events that ended over 30 days ago and that nobody RSVP'd or checked in to.
- **`current_player_id() → uuid`**. The caller's player id, so `/api` functions can identify the caller from their JWT.
- **`claim_radius_m() → meters`** (currently 60). This is the one place the GPS radius is defined. `claim_drop` and `check_in_event` use it, and the client fetches it (`getClaimRadius()` / `useClaimRadius()`) to draw each drop's circle and to enable the Check in buttons. Change it here and both follow.
- **`distance_m(lat1, lng1, lat2, lng2) → meters`**. Haversine on a 6,371 km sphere. `web/src/lib/geo.ts` `distanceM` uses the identical formula, so the client's "in range" matches the server.
- **`next_player_color() → text`**. Default for `players.color`.
- **`is_admin() → boolean`**. Used by RLS. It's callable from the client too, but the app derives admin status from the session.

## Realtime

`drops` and `claims` are in the `supabase_realtime` publication (so are the old game tables, unused). `subscribeToDrops(cb)` fires on every drop insert, update, or delete, which is enough to refresh the map.

## AI event search: `/api/search-events` and `search_quota`

`POST /api/search-events { query }` (Vercel function, `web/api/search-events.ts`) searches Penn State Discover events: the upcoming, uncancelled rows of `discover_events` (read as the caller). Until the first sync fills that table, or if its migration hasn't run (the server logs a reminder once), it searches the snapshot bundled with it instead (`web/scripts/data/discover-events.json`, refreshed by `npm run import-events`):

1. The caller must be a signed-in player (`current_player_id()` under their JWT). The query is 2–200 characters.
2. `use_search_quota() → boolean` takes one search from the caller's allowance (10 per 10 minutes) and refuses with 429 past it. If the function doesn't exist yet (migration not run, `PGRST202`), the server counts the same allowance in memory per instance and logs a reminder once, so search keeps working. Runs as the caller; `search_quota (player_id, window_start, used)` has RLS with no policies, so only the function touches it. It stores a counter only: **queries are never stored or logged**.
3. Gemini gets the upcoming events (the soonest 300: id, title, organization, theme and categories, start time, location), the live drops the client sent (`drops: [{ id, title, at? }]`, up to 150; titles and building names only, never coordinates), and the query, wrapped as data. It returns up to 6 event `{ id, reason }` and the `drop_ids` that fit.
4. Ids are checked against the event list and the sent drops (unknown, ended, and duplicate ids are dropped). The response is `{ results: [{ id, title, organization, theme, starts_at, ends_at, location, building | null, reason }], dropIds: string[] }`; `building` is null for online or vaguely located events.

5. If Gemini can't answer (402 out of credits, 429/5xx after retries, or a garbled answer), `api/_keywordSearch.ts` ranks events and drops by keywords, synonym groups (food, music, sports, tech, ...), emoji, and time words in State College time, with reasons like "Mentions “pizza”". The response's `mode` is `"ai"` or `"keyword"`, and the sheet labels keyword results.

The app links a result to a seeded drop by `drops.source_id = 'discover:<event id>'`.

## Live event sync: `/api/sync-events`

`POST /api/sync-events` (`web/api/sync-events.ts`, logic in `web/api/_discover.ts`) refreshes `discover_events`. Supabase pg_cron calls it every 30 minutes (setup: `docs/SETUP.md`) with `Authorization: Bearer <DISCOVER_SYNC_SECRET>`; any other caller gets 401. `npm run sync-events` runs the same sync from a terminal.

1. Fetches Discover's public event search (approved, not yet ended; 100 per page, up to 5 pages). More than 5 pages makes the sync `complete: false`.
2. Keeps public listings and places each at a building: a building named in the location text, else the organizer's pin, never anything over 4 km from Old Main.
3. Leftovers with an in-person location (not Zoom, Teams, online, links...) are looked up in `discover_locations`. New ones (up to 120 per run) go to Gemini in one call with the buildings within 2.5 km of Old Main. Answers are checked against real building numbers, then cached, "none" included. If Gemini is down or `GEMINI_API_KEY` is unset, the sync goes ahead and asks about those locations next time.
4. Calls `sync_discover_events(events, complete)` and returns a summary: `{ fetched, complete, placed: { text_or_pin, gemini, unplaced }, gemini, asked, events, cancelled, drops_rescheduled, drops_closed }`. A Discover or database failure returns 502 and is logged.

## Club insights: `/api/club-insights`

`POST /api/club-insights { organization }` (`web/api/club-insights.ts`, numbers in `web/api/_clubInsights.ts`) feeds the club dashboard's "Interested" count and "Next event ideas":

1. The caller must be a signed-in player, and `club_stats` (called **as the caller**) must let them in, so only the club's organizers and admins get further. Otherwise 403.
2. With the service key it reads the club's upcoming events, every `player_profiles` row (up to 5,000), those events' RSVPs, and campus events from 60 days ago to two weeks out with their check-in counts.
3. **Interested** = distinct players who RSVP'd to an upcoming event or whose profile matches it (`matchEvent` from `web/src/lib/interests.ts`, the same as "For you"). Returned as counts per event and in total.
4. **Suggestions**: `suggestSlots` scores each weekday at 12, 5, 6, 7 and 8 PM (State College time) by the club's own check-ins and RSVPs there, campus-wide check-ins, and how many other events already sit in that slot over the next two weeks (they split the audience), then picks three different days 2–14 days out, skipping dates the club already has an event, at the building where its events drew the most per event. With `GEMINI_API_KEY`, Gemini gets the same aggregated numbers (the club's own events, slot totals, the candidate buildings, the interested count; **nothing about any player**) and picks three; picks with an unknown weekday, an off-list hour, a repeated day, or no date in range are dropped, and an unknown building becomes no building. If no pick survives or Gemini fails, the numbers' picks are used.
5. Returns `{ interested, interestedByEvent, suggestions: [{ starts_at, building | null, reason }], mode: 'ai' | 'stats' }`. The dashboard labels `stats` suggestions as coming from the numbers.

### Presence: live player locations

Live locations use the Realtime **Presence** channel `campus`, keyed by player id. They are **never written to the database**. A player who has "Show me on the map" on (Profile; default on, stored per device) broadcasts this payload:

```ts
{ playerId, name, color, lat, lng }
```

It sends at most every 5 s, only while the app is open and visible. It untracks when the tab is hidden or the toggle is turned off. See `web/src/session/PresenceProvider.tsx`.

Trails are client-only too. My trail is kept in `localStorage` for today (per device and player) and never sent anywhere. Other players' tails are the last 2 minutes of Presence updates seen this session, in memory only. See `web/src/session/TrailProvider.tsx`.

## Storage

Bucket `drop-hints` is public-read. Only admins can upload to it. Use `uploadHintPhoto(file)`, which returns the public URL.

## Changing the schema

Add a new migration file (don't edit the applied one). Update `database.types.ts` and this doc in the same commit.
