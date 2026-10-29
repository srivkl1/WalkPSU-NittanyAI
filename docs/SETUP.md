# Setup

## 1. Supabase

1. Create a project at supabase.com.
2. Open **SQL Editor** and run each file in `supabase/migrations/` once, in filename order:
   - `20261024000000_init.sql`
   - `20261024010000_territory_and_qr.sql`
   - `20261024020000_individual_players.sql`
   - `20261024030000_shake_off.sql`
   - `20261024040000_remove_building_capture.sql`
   - `20261024050000_event_drops.sql`
   - `20261024060000_photo_hunt.sql`
   - `20261025000000_discovered_areas.sql`
   - `20261025010000_meetups.sql`
   - `20261025020000_quick_draw.sql`
   - `20261025030000_landmark.sql`
   - `20261025030000_needle_rain.sql`
   - `20261025040000_event_search.sql`
   - `20261028000000_discover_sync.sql`
   - `20261028010000_event_rsvps.sql`
   - `20261028020000_player_profiles.sql`
3. Fallback login: go to **Authentication → Sign In / Providers** and turn on **Allow anonymous sign-ins**.
4. Go to **Project Settings → API** and copy the Project URL and the anon (publishable) key into `web/.env`.
5. Photo hunts and AI event search: copy the `service_role` key from the same page into `SUPABASE_SERVICE_ROLE_KEY`, and get a Gemini key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey) for `GEMINI_API_KEY`. Paste only the key, not AI Studio's example `curl` command. On Vercel, add both under **Settings → Environment Variables**.

Make yourself an admin in fallback mode. Join the app first, then run this in the SQL editor:

```sql
update players set is_admin = true where display_name = 'Your Name';
```

## 2. Auth0 (optional until you need real logins)

1. Create a tenant. Make sure its signing algorithm is **RS256** (the default). Supabase rejects HS256 and PS256.
2. **Applications → Create Application → Single Page Application.**
   - Allowed Callback URLs, Logout URLs, and Web Origins: `http://localhost:5173, https://<your-vercel-domain>`
   - Copy the Domain and Client ID into `VITE_AUTH0_DOMAIN` and `VITE_AUTH0_CLIENT_ID`.
3. **User Management → Roles:** create an `admin` role and assign it to organizers.
4. **Actions → Library → Create Action** (trigger: Login / Post Login). Use the code below, then deploy it and add it to the Login flow.

   ```js
   exports.onExecutePostLogin = async (event, api) => {
     api.idToken.setCustomClaim('role', 'authenticated')
     const isAdmin = (event.authorization?.roles ?? []).includes('admin')
     api.idToken.setCustomClaim('app_role', isAdmin ? 'admin' : 'player')
   }
   ```

5. In Supabase, go to **Authentication → Third-Party Auth → Add provider → Auth0** and enter your tenant ID (plus region, if your domain has one).

Once `VITE_AUTH0_DOMAIN` and `VITE_AUTH0_CLIENT_ID` are set, the app switches to Auth0 login automatically.

## 3. Vercel

1. Import the GitHub repo and set **Root Directory** to `web`. The framework preset (Vite) is detected.
2. Add every non-empty variable from `web/.env` under **Settings → Environment Variables**.
3. Deploy. Add the deployed URL to the Auth0 app's callback, logout, and origin lists.

## 4. Demo drops from real campus events (optional)

`web/scripts/data/discover-events.json` is a committed snapshot of upcoming public events from [Penn State Discover](https://discover.psu.edu/events), each matched to a campus building where possible.

1. Apply migration `20261024050000_event_drops.sql` (adds `drops.subtitle`, `starts_at`, `source_id`).
2. Add `SUPABASE_SERVICE_ROLE_KEY=<service_role key from Supabase → Project Settings → API>` to `web/.env`. No `VITE_` prefix: it bypasses RLS and must never reach the browser.
3. From `web/`:
   - `npm run import-events` refreshes the snapshot (4 requests to Discover's public event search).
   - `npm run seed-events -- --dry-run` shows the 12 picks: events starting in the next 48 h (widened a day at a time, up to a week, when there aren't 12 buildings), one per building, spread over campus, mixed themes, never in ECoRE.
   - `npm run seed-events` inserts them as check-in drops that expire when the event ends.
   - `npm run seed-events -- --clear` deletes only the drops it created (`source_id like 'discover:%'`) and their claims.

## 5. Live event sync (every 30 minutes)

`/api/sync-events` keeps `discover_events` current: new events become searchable, rescheduled ones move their seeded drop, and cancelled ones close it (points stay). Gemini places events whose location text the name matcher misses ("340 HHD"). It never creates drops; admins still choose those.

1. Apply `20261028000000_discover_sync.sql`.
2. Pick a long random secret (e.g. `node -e "console.log(crypto.randomUUID() + crypto.randomUUID())"`) and set it as `DISCOVER_SYNC_SECRET` in `web/.env` and in Vercel's environment variables, along with `SUPABASE_SERVICE_ROLE_KEY` and `GEMINI_API_KEY`. Redeploy.
3. Try it from `web/`: `npm run sync-events` (talks to Supabase directly, no secret needed). Search now uses the synced events.
4. In Supabase, enable the **pg_cron** and **pg_net** extensions (**Database → Extensions**), then run this in the SQL Editor with your deployed URL and the same secret:

   ```sql
   select vault.create_secret('<DISCOVER_SYNC_SECRET>', 'discover_sync_secret');

   select cron.schedule('discover-sync', '*/30 * * * *', $$
     select net.http_post(
       url := 'https://<your-vercel-domain>/api/sync-events',
       headers := jsonb_build_object(
         'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'discover_sync_secret')
       ),
       timeout_milliseconds := 60000
     );
   $$);
   ```

   Check runs with `select * from cron.job_run_details order by start_time desc limit 5;` and responses with `select status_code, content from net._http_response order by created desc limit 5;`. Vercel's function logs show each run's summary line (`discover sync: {...}`). To stop: `select cron.unschedule('discover-sync');`.

The secret stays in Supabase Vault, not in the job's SQL. The schedule isn't a migration because it holds your deployment's URL.
