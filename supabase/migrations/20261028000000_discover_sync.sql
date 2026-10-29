-- Live Penn State Discover events. /api/sync-events (run by pg_cron, see docs/SETUP.md) fetches Discover, places each
-- event at a campus building (name matching, then Gemini for the leftovers), and hands the batch to
-- sync_discover_events(). AI event search reads this table instead of the bundled snapshot. Only public event facts:
-- no descriptions, organizer contacts, or attendee data.

create table discover_events (
  id text primary key, -- Discover's event id; seeded drops point here with source_id = 'discover:<id>'
  title text not null,
  organization text,
  theme text,
  categories text[] not null default '{}',
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  location text,
  -- { num, name, lat, lng, matched_by }, or null for online events and ones away from University Park.
  building jsonb,
  -- Gone from Discover before it ended (cancelled, or made private).
  cancelled boolean not null default false,
  synced_at timestamptz not null default now()
);

create index discover_events_ends_at on discover_events (ends_at) where not cancelled;

-- Public listings: any signed-in player may read them. Only sync_discover_events() writes.
alter table discover_events enable row level security;
create policy "players read events" on discover_events for select to authenticated, service_role using (true);
revoke insert, update, delete on discover_events from anon, authenticated;
revoke select on discover_events from anon;
grant select on discover_events to service_role;

-- Gemini's answer for a free-text location ("104 Pasquerilla", "340 HHD"), so each one is asked about only once.
create table discover_locations (
  location text primary key, -- lowercased, whitespace collapsed
  building_num text,         -- null: not a University Park building (off campus, outdoors, unclear)
  checked_at timestamptz not null default now()
);

-- Server only: players get no privileges at all. The policy is explicit, so it doesn't rely on BYPASSRLS.
alter table discover_locations enable row level security;
create policy "server manages locations" on discover_locations for all to service_role using (true) with check (true);
revoke all on discover_locations from anon, authenticated;
grant select, insert, update on discover_locations to service_role;

-- Applies one sync. p_events is every listing Discover returned (the shape of scripts/data/discover-events.json's
-- events). p_complete says the fetch got all of them; only then does an upcoming event that's missing count as
-- cancelled, so a truncated fetch never cancels anything.
-- Drops seeded from an event follow it: rescheduled while active, and closed (never deleted, so points stay) when the
-- event is cancelled. A drop an admin already closed stays closed.
create function sync_discover_events(p_events jsonb, p_complete boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_events integer;
  v_cancelled integer := 0;
  v_rescheduled integer;
  v_closed integer;
begin
  if jsonb_typeof(p_events) is distinct from 'array' then
    raise exception 'p_events must be an array';
  end if;

  insert into discover_events as d (id, title, organization, theme, categories, starts_at, ends_at, location, building, cancelled, synced_at)
  select distinct on (e->>'id')
    e->>'id', e->>'title', e->>'organization', e->>'theme',
    array(select jsonb_array_elements_text(coalesce(e->'categories', '[]'))),
    (e->>'starts_at')::timestamptz, (e->>'ends_at')::timestamptz, e->>'location',
    nullif(e->'building', 'null'::jsonb), false, now()
  from jsonb_array_elements(p_events) e
  order by e->>'id'
  on conflict (id) do update set
    title = excluded.title, organization = excluded.organization, theme = excluded.theme,
    categories = excluded.categories, starts_at = excluded.starts_at, ends_at = excluded.ends_at,
    location = excluded.location, building = excluded.building, cancelled = false, synced_at = now();
  get diagnostics v_events = row_count;

  if p_complete then
    update discover_events set cancelled = true, synced_at = now()
    where not cancelled and ends_at > now()
      and not exists (select 1 from jsonb_array_elements(p_events) e where e->>'id' = discover_events.id);
    get diagnostics v_cancelled = row_count;
  end if;

  update drops dr set starts_at = d.starts_at, expires_at = d.ends_at
  from discover_events d
  where dr.source_id = 'discover:' || d.id and dr.status = 'active' and not d.cancelled
    and (dr.starts_at is distinct from d.starts_at or dr.expires_at is distinct from d.ends_at);
  get diagnostics v_rescheduled = row_count;

  update drops dr set status = 'expired', expires_at = least(coalesce(dr.expires_at, now()), now())
  from discover_events d
  where dr.source_id = 'discover:' || d.id and dr.status = 'active' and d.cancelled;
  get diagnostics v_closed = row_count;

  -- Search only looks ahead; a month of history is plenty.
  delete from discover_events where ends_at < now() - interval '30 days';

  return jsonb_build_object('events', v_events, 'cancelled', v_cancelled, 'drops_rescheduled', v_rescheduled, 'drops_closed', v_closed);
end;
$$;

revoke execute on function sync_discover_events from public, anon, authenticated;
grant execute on function sync_discover_events to service_role;
