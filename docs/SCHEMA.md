# Schema

Source of truth: the files in `supabase/migrations/`, applied in order. TypeScript mirror: `web/src/lib/database.types.ts`. Call everything through `web/src/lib/api.ts`.

Players compete as **individuals**. There are no permanent teams anywhere in the data model (migration `20261024020000_individual_players.sql` removed them). Buildings aren't owned or captured (migration `20261024040000_remove_building_capture.sql` removed that).

## Identity

Every request carries a JWT. Its `sub` claim is the user's id: the Auth0 user id (`auth0|abc…`) or, in fallback mode, the Supabase anonymous user id. `players.auth_id` stores that `sub`, and the database fills it in automatically on insert. You never send it.

A user is an **admin** if either:

- the Auth0 ID token has `app_role: "admin"` (set by the Auth0 Action from the user's Auth0 roles), or
- their `players.is_admin` is `true` (set by hand in the Supabase dashboard; this is how admins work in fallback mode).

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
| `type` | `minigame` \| `photo_hunt` \| `checkin` \| `meetup` | `meetup` = a player's social pin from `create_meetup` (no points) |
| `lat`, `lng` | double precision | |
| `points` | integer | > 0, default 10 |
| `status` | `active` \| `claimed` \| `expired` | default `active`; becomes `claimed` via `claim_drop` |
| `hint_photo_url` | text | public URL in the `drop-hints` storage bucket. For photo hunts, the reference photo of the spot |
| `twist` | text | photo hunts: what the player's photo must also show, e.g. "with a thumbs up" |
| `search_radius_m` | integer | photo hunts: radius of the search circle shown before the first find |
| `first_found_at` | timestamptz | photo hunts: when the first player found it. null = not found yet, so `lat`/`lng` is only the search circle's center |
| `building_num` | text | PSU building number (`num` in `buildings.geojson`). null = open-ground drop. The map highlights a building while it hosts an active drop. Photo hunts keep it null until the first find |
| `created_by` | uuid → `players` | |
| `created_at` | timestamptz | |
| `expires_at` | timestamptz | null = never. Past this time the drop can't be claimed even if `status` is still `active` |
| `subtitle` | text | optional line under the title; the hosting organization for imported campus events |
| `starts_at` | timestamptz | optional; when the event behind the drop begins. The drop card shows it with `expires_at` |
| `source_id` | text | unique. Set only on drops seeded from campus events (`discover:<event id>`, by `web/scripts/seed-event-drops.mjs`); null for drops made in `/admin` |
| `game` | `shake_off` \| `quick_draw` \| `landmark` \| `needle_rain` | `minigame` drops only: which game the lobby plays. A trigger sets `shake_off` when a minigame insert leaves it out and clears it on other types |

Only admins can insert, update, or delete. Everyone signed in can read. Create photo hunts with `create_photo_hunt`, not a plain insert, so the spot stays hidden.

### `claims`

| column | type | notes |
| --- | --- | --- |
| `id` | uuid | |
| `drop_id` | uuid → `drops` | unique together with `player_id` |
| `player_id` | uuid → `players` | who claimed it |
| `points` | integer | what this claim earned. A trigger fills in the drop's `points` when an insert leaves it out (`claim_drop`, `finish_game`); `claim_photo_hunt` sets less for later finders |
| `created_at` | timestamptz | |

Read-only for clients. Rows come only from `claim_drop` (one claim per ordinary drop: it locks the drop and flips it to `claimed`), `finish_game` (one claim per winner of a Shake-Off or Quick Draw, or exactly one claim for a Needle Rain winner), and `claim_photo_hunt` (one claim per finder).

### `drop_secrets`

| column | type | notes |
| --- | --- | --- |
| `drop_id` | uuid → `drops` | primary key |
| `claim_code` | text | 32-char random code encoded in the drop's QR |
| `hunt_lat`, `hunt_lng` | double precision | photo hunts: the exact spot |
| `hunt_building_num` | text | photo hunts: the spot's building, copied to `drops.building_num` on the first find |

Created automatically by a trigger when a drop is inserted. **Only admins can read it**; players never see codes except by scanning. The QR encodes `https://<app>/claim/<drop_id>?key=<claim_code>`.

### `games` (mini-games)

One per `minigame` drop, created by the first `join_game`. Every kind (`drops.game`) shares this lobby, the join rules, and the side split.

| column | type | notes |
| --- | --- | --- |
| `drop_id` | uuid → `drops` | primary key |
| `seed` | text | random; decides sides, tie-breaks, and Quick Draw's signal moments. Hidden from `get_game_state`. Needle Rain ties use it too. It is not the storm |
| `round_seed` | text | Needle Rain's public storm. Null until a start is scheduled, and `get_game_state` only returns it once `started_at` is set |
| `ghost_seed` | text | practice-run storm. Never the live `round_seed` |
| `ghost_dodges` | integer | best solo practice count, server-capped. Null until someone practices |
| `ghost_player_id` | uuid → `players` | whose practice that is |
| `created_at` | timestamptz | |
| `started_at` | timestamptz | null until scheduled. The future time the game begins; the lobby closes then |
| `finished_at` | timestamptz | set by `finish_game`. A practice run does not set it |
| `winner_side` | `blue` \| `white` | Shake-Off and Quick Draw. Null for Needle Rain |
| `winner_id` | uuid → `players` | Needle Rain's one winner |

### `game_players`

| column | type | notes |
| --- | --- | --- |
| `drop_id`, `player_id` | uuid | primary key |
| `joined_at` | timestamptz | |
| `shakes` | integer | the server-capped count from `submit_shakes` |
| `dodges` | integer | Needle Rain. The server-capped count from `submit_dodges`. Not a reuse of `shakes` |
| `eliminated` | boolean | Needle Rain. A hit freezes `dodges` |

### `game_results` (timed games)

| column | type | notes |
| --- | --- | --- |
| `drop_id`, `player_id`, `round` | uuid, uuid, smallint | primary key. The first submission for a round is final |
| `value` | double precision | the round's score, lower is better. Quick Draw: reaction time in ms. Point to the Landmark: error in degrees (0–180). Null exactly when `false_start` |
| `false_start` | boolean | Quick Draw: flicked before the signal, or under `min_reaction_ms` |
| `heading` | double precision | Point to the Landmark: the locked true heading, [0, 360) |
| `created_at` | timestamptz | |

### `campus_landmarks`

`num` (PSU building number, as in `buildings.geojson`), `name`, `lat`, `lng`: 15 well-known landmarks (Old Main, Beaver Stadium, the BJC, Pattee, the HUB, Rec Hall, the Creamery…) that Point to the Landmark asks for. Seeded by the migration; everyone signed in can read it, nobody can write.

`games`, `game_players`, and `game_results` are read-only for clients and in the Realtime publication. Sides aren't stored: `game_sides(drop_id)` deals them from the seed once `started_at` is set, so every caller sees the same balanced split. Teams exist only inside one game.

### `player_scores` (view)

`player_id, display_name, color, points, claims` for every player. `points` is the sum of their claims' `points`. Runs with the caller's permissions. The leaderboard orders by points, then name.

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
| `title`, `organization`, `theme` | text | public listing facts only: no descriptions, organizer contacts, or attendees |
| `categories` | text[] | |
| `starts_at`, `ends_at` | timestamptz | |
| `location` | text | as the organizer typed it |
| `building` | jsonb | `{ num, name, lat, lng, matched_by }` (`location text`, `coordinates`, or `gemini`); null for online events and ones away from University Park |
| `cancelled` | boolean | gone from a complete Discover fetch before it ended; cleared if it reappears |
| `synced_at` | timestamptz | |

Written only by `sync_discover_events`. RLS: signed-in players read every row; nobody writes. Events that ended over 30 days ago are pruned on each sync. Not in the Realtime publication (search reads it per request).

### `player_profiles` (major and interests, private)

`player_id` (PK, references `players`, cascade delete), `major` (null, or 1–80 characters), `interests` (text[], each one of the ids in `web/src/lib/interests.ts`'s `INTERESTS`, enforced by a check constraint; keep the two lists in step), `updated_at`. RLS: a player reads, inserts, and updates **only their own row**; nobody deletes (clear the fields instead); anon has nothing. Nothing else reads it: "For you" matching runs on the phone (`matchEvent`/`forYou`) against `discover_events`' `categories`, `theme`, `benefits`, and title words.

`discover_events.benefits` (text[], added with this table) holds Discover's `benefitNames` ("Free Food", "Free Stuff"); `sync_discover_events` stores it.

### `event_rsvps` (WalkPSU's own "I'm going")

`event_id` (references `discover_events`, cascade delete), `player_id` (references `players`, cascade delete), `created_at`. Primary key `(event_id, player_id)`. RLS: a player reads only their own rows; no direct writes for anyone (`set_going` writes). Others see only counts, through `event_going`, **never who is going**. Discover's own RSVP numbers (`rsvpTotal`) are deliberately not used.

### `discover_locations` (Gemini placement cache)

`location` (PK, lowercased with whitespace collapsed), `building_num` (null: Gemini said it isn't a campus building), `checked_at`. Service role only, so each free-text location costs one Gemini call ever. Players have no privileges on it.

## Functions

- **`claim_drop(p_drop_id, p_lat?, p_lng?, p_code?) → claims`**. Claims a drop for the caller. It locks the drop row, so if two players tap at once exactly one wins. Proof is either the drop's QR `p_code` (any distance) or a GPS position within `claim_radius_m()`. It raises an error with a user-facing message when:
  - the caller hasn't joined,
  - the drop is gone, claimed, or expired,
  - the code is wrong,
  - there's no code and no position,
  - there's no code and the caller is too far away.

  Client: `claimDrop(dropId, { lat, lng })` or `claimDrop(dropId, { code })`.
- **Mini-game functions** (all keyed by the drop id; phases come from timestamps, so there's no server timer):
  - `get_game_state(drop) → { server_now, kind, settings, game, players[], rounds[], results[] }`. One call per screen. `server_now` lets phones correct skewed clocks. `settings` is `minigame_settings(kind)`. `rounds` (Quick Draw, once a start is set) holds each round's `starts_at` and `signal_at`; Point to the Landmark's hold each round's `starts_at`, `landmark` (`num, name, lat, lng`), and true `bearing` from the drop. `results` holds every `game_results` row, including a heading when the game stored one. Needle Rain's `game` includes `round_seed` only after a start is set, plus the ghost record.
  - `join_game(drop, lat?, lng?, code?)`. Same proof as claiming. Rejoining is a no-op. Joining closes at `started_at`. The Nth player (`auto_start_players`, 4 for Shake-Off, Quick Draw, and Point to the Landmark, 2 for Needle Rain) schedules the start `auto_start_delay_seconds` out. Scheduling a Needle Rain also sets `round_seed`.
  - `start_game(drop)`. Admin only, needs 2+ players. Pulls the start in to `admin_start_delay_seconds` from now (5 s for Shake-Off, 3 s for Needle Rain).
  - `submit_shakes(drop, count)`. Shake-Off only. Running total during and just after the game. Stored as `greatest(previous, min(count, floor(elapsed_seconds × max_shakes_per_second)))`, so a client can't report more than a human could shake.
  - `submit_reaction(drop, round, reaction_ms?)`. Quick Draw only. The phone times the reaction itself (`performance.now()` from the frame that shows "DRAW!" to the flick), so network lag never counts; no `reaction_ms` = flicked before the signal. Under `min_reaction_ms` is stored as a false start. Refused: a round that doesn't exist or hasn't begun, a time outside 0..`max_reaction_ms`, a time the server's clock says couldn't have happened yet (`now < signal_at + reaction_ms − clock_tolerance_ms`), and anything after `signal_at + max_reaction_ms + submit_grace_seconds`.
  - `submit_heading(drop, round, heading)`. Point to the Landmark only. The phone's locked true heading; the server stores the error `angle_diff(heading, bearing)` from the round's true bearing (`bearing_deg` from the **drop's** location to the landmark, not the phone's). Refused: a round that doesn't exist or hasn't begun, a heading outside [0, 360) or NaN, and anything after `point_seconds + submit_grace_seconds` into the round. First heading per round is final.
  - `landmark_rounds(game)`: each round's landmark, a different seeded pick among `campus_landmarks` at least `min_landmark_m` from the drop (the farthest fill in if too few qualify), with its bearing.
  - `submit_dodges(drop, count, eliminated?)`. Needle Rain only. Stored as `greatest(previous, min(count, floor(elapsed_seconds × max_dodges_per_second)))`. Once `eliminated` is stored, later reports return the frozen count. Broadcast positions are cosmetic.
  - `submit_ghost(drop, count)`. Needle Rain practice, only while the round has not started. Caps at `game_seconds × max_dodges_per_second` and replaces the lobby record only when the new count is higher. Pays nothing and does not set `finished_at`.
  - `finish_game(drop)`. Idempotent; any client calls it after `game_seconds + submit_grace_seconds` (per kind). `side_scores(drop, kind)` scores each side: Shake-Off, average shakes per player (higher wins, fair for uneven sides); Quick Draw, the average of each player's best valid time, with `max_reaction_ms` for a player who has none (lower wins); Point to the Landmark, the average of each player's mean error over all rounds, a round without a heading counting `miss_degrees` (lower wins). An exact tie goes to a seeded coin flip. Every winner on that side gets a claim worth the drop's points, and the drop is marked claimed. Needle Rain skips sides: the highest dodge count among players still standing wins (or among everyone if all are out). An exact tie uses the same seeded coin flip. Exactly one claim, for `winner_id`.
  - `shake_off_settings()`: `game_seconds` 15, `auto_start_players` 4, `auto_start_delay_seconds` 15, `admin_start_delay_seconds` 5, `max_shakes_per_second` 8, `submit_grace_seconds` 3. `minigame_settings(kind)` adds each kind's own: Quick Draw `game_seconds` 30, `rounds` 3, `round_seconds` 10, signal 2000–6000 ms into each round (`quick_draw_signal_at(game, round)`, seeded), `min_reaction_ms` 100, `max_reaction_ms` 1500, `clock_tolerance_ms` 1000. Point to the Landmark `game_seconds` 42, `rounds` 3, `round_seconds` 14 (`point_seconds` 8, then the reveal), `steady_ms` 1000, `steady_degrees` 6, `lock_after_ms` 1500, `min_landmark_m` 200, `miss_degrees` 180. Needle Rain (`needle_rain_settings()`): `game_seconds` 40, `auto_start_players` 2, `auto_start_delay_seconds` 3, `admin_start_delay_seconds` 3, `max_dodges_per_second` 4, `submit_grace_seconds` 3. The client reads them from `get_game_state`; don't copy them into client code.
  - `claim_drop` refuses `minigame` drops, so the game can't be skipped.
- **Photo hunt functions:**
  - `create_photo_hunt(p_title, p_lat, p_lng, p_hint_photo_url, p_twist, p_points?, p_building_num?, p_expires_at?) → drops`. Admin only. Saves the exact spot and building in `drop_secrets` and publishes the drop at a random point up to 3/4 of `search_radius_m` (125 m) away, so neither the row nor its Realtime insert reveals the spot. Client: `createPhotoHunt(...)`.
  - `photo_hunt_check(drop, player, lat, lng) → drops` and `claim_photo_hunt(...) → claims`. **Service role only**, called by `web/api/verify-photo.ts`. The check raises a user-facing error unless the hunt is open, the player hasn't found it yet, and they're within `claim_radius_m()` of the exact spot. It never says how far off they are. The claim reruns the check under a row lock, then records points: full for the first finder, halved for each earlier finder, at least 1. The first find copies the exact spot and building onto the drop (the map's red pin and building highlight) and sets `expires_at` to 7 minutes later unless it was due sooner. The drop stays `active` until then.
  - `current_player_id() → uuid`. The caller's player id, so `/api` functions can identify the caller from their JWT.
  - `claim_drop` refuses `photo_hunt` drops, by GPS and by QR.
- **Meetups and clearing:**
  - `create_meetup(p_text, p_lat, p_lng, p_minutes = 60, p_building_num?) → drops`. Any joined player. Inserts a `meetup` drop titled with the trimmed text (3–80 characters), subtitle "Started by <name>", at the given position (must be within 5 km of Old Main), expiring after `p_minutes` clamped to 15–180. Posting again expires the player's previous live meetup, and a player can post at most 5 an hour. `points` is 1 only to satisfy the column check: `claim_drop` refuses meetups. Client: `createMeetup(...)`.
  - `close_drop(p_drop_id)`. Admins may clear any drop; a player may end a meetup they started. Sets `status = 'expired'` (and `expires_at` to now), never deletes, so claims and points from the drop stay. Client: `closeDrop(dropId)`.
- **`discover_area(p_hex_id) → boolean`**. Records an area for the caller; `true` if new, `false` if they already had it (duplicates are ignored). Runs as the caller (`security invoker`), so the insert policy applies. The client calls it from `DiscoveryProvider` only on a GPS fix with accuracy ≤ 20 m inside one of the campus areas. Client: `discoverArea(hexId)`, `getDiscoveredAreas()`.
- **Event RSVPs:**
  - `event_going(p_event_ids text[]) → (event_id, going, me)[]`. Each listed event's going count and whether the caller is going (first 100 ids; unknown ids are left out). Counts only. Client: `getGoing(eventId)`.
  - `set_going(p_event_id, p_going) → integer`. Turns the caller's RSVP on or off and returns the new count. Going is refused for an event that's over or cancelled (or unknown, or before joining); un-RSVPing always works. Client: `setGoing(eventId, going)`.
- **`sync_discover_events(p_events jsonb, p_complete boolean) → { events, cancelled, drops_rescheduled, drops_closed }`**. **Service role only**, called by `/api/sync-events`. Upserts every listing in `p_events` (duplicate ids count once; `lat`/`lng` aren't stored). Only when `p_complete` (the fetch got every page) does an upcoming event missing from the batch become `cancelled`, so a truncated fetch never cancels anything. Seeded drops follow their event: an `active` drop gets the event's new `starts_at`/`expires_at`, and a cancelled event's active drop is closed like `close_drop` (`status = 'expired'`, never deleted, so its points stay). A drop that's already closed stays closed.
- **`claim_radius_m() → meters`** (currently 60). This is the one place the GPS claim radius is defined. `claim_drop` uses it, and the client fetches it (`getClaimRadius()` / `useClaimRadius()`) to draw each drop's radius circle and to enable the Claim button. Change it here and both follow.
- **`distance_m(lat1, lng1, lat2, lng2) → meters`**. Haversine on a 6,371 km sphere. `web/src/lib/geo.ts` `distanceM` uses the identical formula, so the client's "in range" matches the server.
- **`next_player_color() → text`**. Default for `players.color`.
- **`is_admin() → boolean`**. Used by RLS. It's callable from the client too, but the app derives admin status from the session.

## Realtime

`drops`, `claims`, `games`, `game_players`, and `game_results` are in the `supabase_realtime` publication. `subscribeToDrops(cb)` fires on every drop insert, update, or delete, which is enough to refresh the map. A photo hunt's later finders add claims without touching the drop, so the leaderboard listens to `claims`.

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

## Photo hunts and `/api/verify-photo`

1. The player takes a photo. The client shrinks it to a 1280 px JPEG and POSTs `{ dropId, lat, lng, image }` (base64) to `/api/verify-photo` with their JWT as `Authorization: Bearer …` (`submitHuntPhoto`).
2. The function resolves the player with `current_player_id()` under that JWT, then runs `photo_hunt_check` with the service key. Failures come back as `{ error }` with a 4xx status.
3. It sends the reference photo, the player's photo, and the twist to Gemini, which answers `same_place`, `twist_done`, `photo_of_screen_or_print`, and a one-sentence `reason`. A busy or retired model is retried, then other models are tried (`GEMINI_ATTEMPTS`).
4. On a match it calls `claim_photo_hunt` and returns `{ match: true, points, reason }`. Otherwise it returns `{ match: false, reason }`. Player photos are never stored.

The function needs `GEMINI_API_KEY` and `SUPABASE_SERVICE_ROLE_KEY`. `npm run dev` serves `web/api/*.ts` through a small Vite plugin in `vite.config.ts`, and Vercel serves them in production. `npm run test-gemini -- <reference> <photo> ["twist"]` tries the referee on two local photos without the database.

### Broadcast: live Shake-Off counts

Channel `shakeoff:<drop_id>`, event `shakes`, payload `{ playerId, count }`. Each participant sends about every 500 ms. It only drives the tug-of-war bar on phones and `/battle/:dropId`. The winner is decided solely from the capped counts stored by `submit_shakes`.

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
