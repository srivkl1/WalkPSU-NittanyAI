-- Personal profiles (major and interests) for "For you" event picks, plus Discover's event benefits ("Free Food",
-- "Free Stuff"), which the free-food and free-stuff interests match.
-- A profile is private: only its owner reads or writes it. Matching happens on the phone.

create table player_profiles (
  player_id uuid primary key references players (id) on delete cascade,
  major text check (major is null or char_length(major) between 1 and 80),
  -- Ids from INTERESTS in web/src/lib/interests.ts. Keep this list in step with it.
  interests text[] not null default '{}' check (
    cardinality(interests) <= 14
    and interests <@ array['free_food', 'free_stuff', 'career', 'academic', 'tech', 'wellness', 'sports', 'arts', 'culture',
      'social', 'sustainability', 'service', 'faith', 'clubs']
  ),
  updated_at timestamptz not null default now()
);

alter table player_profiles enable row level security;
create policy "players read own profile" on player_profiles for select to authenticated using (player_id = current_player_id());
create policy "players add own profile" on player_profiles for insert to authenticated with check (player_id = current_player_id());
create policy "players change own profile" on player_profiles for update to authenticated
  using (player_id = current_player_id()) with check (player_id = current_player_id());
revoke all on player_profiles from anon;
revoke delete on player_profiles from authenticated;

-- Discover's benefits for each event.
alter table discover_events add column benefits text[] not null default '{}';

-- As in 20261028000000_discover_sync.sql, now also storing benefits.
create or replace function sync_discover_events(p_events jsonb, p_complete boolean)
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

  insert into discover_events as d (id, title, organization, theme, categories, benefits, starts_at, ends_at, location, building, cancelled, synced_at)
  select distinct on (e->>'id')
    e->>'id', e->>'title', e->>'organization', e->>'theme',
    array(select jsonb_array_elements_text(coalesce(e->'categories', '[]'))),
    array(select jsonb_array_elements_text(coalesce(e->'benefits', '[]'))),
    (e->>'starts_at')::timestamptz, (e->>'ends_at')::timestamptz, e->>'location',
    nullif(e->'building', 'null'::jsonb), false, now()
  from jsonb_array_elements(p_events) e
  order by e->>'id'
  on conflict (id) do update set
    title = excluded.title, organization = excluded.organization, theme = excluded.theme,
    categories = excluded.categories, benefits = excluded.benefits, starts_at = excluded.starts_at,
    ends_at = excluded.ends_at, location = excluded.location, building = excluded.building, cancelled = false,
    synced_at = now();
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

  delete from discover_events where ends_at < now() - interval '30 days';

  return jsonb_build_object('events', v_events, 'cancelled', v_cancelled, 'drops_rescheduled', v_rescheduled, 'drops_closed', v_closed);
end;
$$;
