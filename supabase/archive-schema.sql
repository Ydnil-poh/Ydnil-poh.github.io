create extension if not exists vector;

create table if not exists public.archive_records (
  slug text primary key,
  title text not null,
  body_digest text,
  metadata jsonb not null default '{}'::jsonb,
  score double precision not null default 0,
  cluster integer,
  position jsonb not null default '{"x":0.5,"y":0.5}'::jsonb,
  views integer not null default 0,
  tile_clicks integer not null default 0,
  page_views integer not null default 0,
  opens integer not null default 0,
  runtime_score double precision not null default 0,
  human_modal_open integer not null default 0,
  human_full_open integer not null default 0,
  human_score double precision not null default 0,
  machine_access integer not null default 0,
  machine_score double precision not null default 0,
  last_event_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.archive_records
add column if not exists tile_clicks integer not null default 0,
add column if not exists page_views integer not null default 0,
add column if not exists opens integer not null default 0,
add column if not exists runtime_score double precision not null default 0,
add column if not exists human_modal_open integer not null default 0,
add column if not exists human_full_open integer not null default 0,
add column if not exists human_score double precision not null default 0,
add column if not exists machine_access integer not null default 0,
add column if not exists machine_score double precision not null default 0,
add column if not exists last_event_at timestamptz,
-- Deleted repo records are tombstoned rather than erased so their events and
-- snapshots keep their referent; reappearing slugs clear the marker on upsert.
add column if not exists removed_at timestamptz;

create table if not exists public.archive_events (
  id bigserial primary key,
  record_slug text references public.archive_records(slug) on delete set null,
  event_type text not null check (event_type in ('tile_click', 'record_open', 'page_view')),
  path text,
  referrer text,
  session_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- Machine Attention Layer principle:
-- Store observations, not interpretations. The raw user_agent is the
-- observation; agent/category/confidence are derived labels that may be
-- recomputed as classification rules improve. Scoring weights live in
-- record_machine_event and can change without touching stored events.
create table if not exists public.machine_events (
  id bigserial primary key,
  record_slug text references public.archive_records(slug) on delete set null,
  path text,
  agent text not null,
  category text not null check (category in ('search', 'crawler', 'ai', 'preview', 'unknown')),
  confidence double precision not null default 0,
  user_agent text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- Existing deployments predate the preview category; refresh the check
-- constraint so link-unfurler observations are accepted.
alter table public.machine_events
drop constraint if exists machine_events_category_check;
alter table public.machine_events
add constraint machine_events_category_check
check (category in ('search', 'crawler', 'ai', 'preview', 'unknown'));

create index if not exists machine_events_record_idx
on public.machine_events (record_slug, created_at);

create index if not exists machine_events_category_idx
on public.machine_events (category, created_at);

alter table public.machine_events enable row level security;

-- No public policies on machine_events: writes go through the security
-- definer record_machine_event function; reads happen with the service role.

-- History layer principle:
-- Store observations, not interpretations.
-- These append-only rebuild/layout tables preserve what happened during archive
-- generation. Do not store growth roles, colors, bridge labels, or centrality
-- interpretations here; derive those later from accumulated observations.
-- Child observations inherit time from archive_rebuilds.generated_at rather than
-- storing duplicate created_at timestamps.
create table if not exists public.archive_rebuilds (
  id uuid primary key,
  generated_at timestamptz not null,
  rebuild_mode text not null,
  manifest_schema_version integer not null,
  record_count integer not null default 0,
  changed_record_count integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.archive_record_snapshots (
  rebuild_id uuid references public.archive_rebuilds(id) on delete cascade,
  record_slug text references public.archive_records(slug) on delete cascade,
  region_id text,
  layout_slot integer,
  position jsonb not null default '{"x":0.5,"y":0.5}'::jsonb,
  score double precision not null default 0,
  content_hash text,
  relation_count integer not null default 0,
  relation_weight_sum double precision not null default 0,
  runtime_score double precision not null default 0,
  human_score double precision not null default 0,
  machine_score double precision not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  primary key (rebuild_id, record_slug)
);

create table if not exists public.archive_region_snapshots (
  rebuild_id uuid references public.archive_rebuilds(id) on delete cascade,
  region_id text not null,
  tag text,
  seed_slot integer,
  footprint jsonb not null default '{}'::jsonb,
  occupied_slots integer not null default 0,
  available_slots integer not null default 0,
  density double precision not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  primary key (rebuild_id, region_id)
);

create table if not exists public.archive_layout_events (
  rebuild_id uuid references public.archive_rebuilds(id) on delete cascade,
  event_index integer not null,
  -- Event types are application-managed namespaces such as layout.slot_preserved
  -- or record.first_seen. Avoid enum/check constraints so new observations do
  -- not require schema migrations.
  event_type text not null,
  record_slug text references public.archive_records(slug) on delete set null,
  region_id text,
  from_slot integer,
  to_slot integer,
  anchor_slug text references public.archive_records(slug) on delete set null,
  anchor_kind text,
  metadata jsonb not null default '{}'::jsonb,
  primary key (rebuild_id, event_index)
);

create table if not exists public.archive_embeddings (
  record_slug text primary key references public.archive_records(slug) on delete cascade,
  embedding vector(64),
  model text,
  content_hash text,
  updated_at timestamptz not null default now()
);

create table if not exists public.archive_relations (
  source_slug text references public.archive_records(slug) on delete cascade,
  target_slug text references public.archive_records(slug) on delete cascade,
  cosine_distance double precision not null,
  relation_weight double precision not null,
  updated_at timestamptz not null default now(),
  primary key (source_slug, target_slug)
);

create index if not exists archive_embeddings_embedding_idx
on public.archive_embeddings
using ivfflat (embedding vector_cosine_ops)
with (lists = 100);

create index if not exists archive_record_snapshots_record_idx
on public.archive_record_snapshots (record_slug, rebuild_id);

create index if not exists archive_region_snapshots_region_idx
on public.archive_region_snapshots (region_id, rebuild_id);

create index if not exists archive_layout_events_record_idx
on public.archive_layout_events (record_slug, event_type, rebuild_id, event_index);

create index if not exists archive_layout_events_anchor_idx
on public.archive_layout_events (anchor_slug, event_type, rebuild_id, event_index);

alter table public.archive_records enable row level security;
alter table public.archive_embeddings enable row level security;
alter table public.archive_relations enable row level security;
alter table public.archive_events enable row level security;
alter table public.archive_rebuilds enable row level security;
alter table public.archive_record_snapshots enable row level security;
alter table public.archive_region_snapshots enable row level security;
alter table public.archive_layout_events enable row level security;

drop policy if exists "public read archive records" on public.archive_records;
drop policy if exists "public read archive relations" on public.archive_relations;
drop policy if exists "public insert archive events" on public.archive_events;

create policy "public read archive records"
on public.archive_records
for select
using (true);

create policy "public read archive relations"
on public.archive_relations
for select
using (true);

create policy "public insert archive events"
on public.archive_events
for insert
with check (true);

drop function if exists public.increment_record_view(text);
drop function if exists public.record_archive_event(text, text, jsonb);

create or replace function public.record_archive_event(
  record_slug text,
  event_type text default 'tile_click',
  event_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_event text := coalesce(event_type, 'tile_click');
  payload jsonb := coalesce(event_metadata, '{}'::jsonb);
  updated_record public.archive_records%rowtype;
  runtime_delta double precision;
begin
  if normalized_event not in ('tile_click', 'record_open', 'page_view') then
    raise exception 'unsupported archive event type: %', normalized_event;
  end if;

  runtime_delta := case normalized_event
    when 'tile_click' then 0.15
    when 'record_open' then 0.35
    when 'page_view' then 0.25
    else 0
  end;

  update public.archive_records
  set
    views = views + case when normalized_event in ('tile_click', 'record_open', 'page_view') then 1 else 0 end,
    tile_clicks = tile_clicks + case when normalized_event = 'tile_click' then 1 else 0 end,
    opens = opens + case when normalized_event = 'record_open' then 1 else 0 end,
    page_views = page_views + case when normalized_event = 'page_view' then 1 else 0 end,
    runtime_score = runtime_score + runtime_delta,
    human_modal_open = human_modal_open + case when normalized_event = 'tile_click' then 1 else 0 end,
    human_full_open = human_full_open + case when normalized_event = 'record_open' then 1 else 0 end,
    human_score = human_score + case normalized_event
      when 'tile_click' then 0.15
      when 'record_open' then 0.35
      else 0
    end,
    last_event_at = now(),
    updated_at = now()
  where slug = record_slug
  returning * into updated_record;

  if updated_record.slug is null then
    return jsonb_build_object('slug', record_slug, 'ignored', true, 'reason', 'unknown_record');
  end if;

  insert into public.archive_events (record_slug, event_type, path, referrer, session_id, metadata)
  values (
    record_slug,
    normalized_event,
    payload->>'path',
    payload->>'referrer',
    payload->>'sessionId',
    payload
  );

  return jsonb_build_object(
    'slug', updated_record.slug,
    'views', updated_record.views,
    'tileClicks', updated_record.tile_clicks,
    'opens', updated_record.opens,
    'pageViews', updated_record.page_views,
    'runtimeScore', updated_record.runtime_score,
    'humanModalOpen', updated_record.human_modal_open,
    'humanFullOpen', updated_record.human_full_open,
    'humanScore', updated_record.human_score,
    'machineAccess', updated_record.machine_access,
    'machineScore', updated_record.machine_score,
    'lastEventAt', updated_record.last_event_at
  );
end;
$$;

create or replace function public.increment_record_view(record_slug text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  event_result jsonb;
begin
  event_result := public.record_archive_event(record_slug, 'page_view', '{}'::jsonb);
  return (event_result->>'views')::integer;
end;
$$;

grant execute on function public.record_archive_event(text, text, jsonb) to anon, authenticated;
grant execute on function public.increment_record_view(text) to anon, authenticated;

drop function if exists public.record_machine_event(text, text, text, double precision, text, text, jsonb);

create or replace function public.record_machine_event(
  event_path text,
  agent_name text,
  agent_category text,
  agent_confidence double precision default 0,
  agent_user_agent text default null,
  record_slug text default null,
  event_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_category text := case
    when agent_category in ('search', 'crawler', 'ai', 'preview') then agent_category
    else 'unknown'
  end;
  clamped_confidence double precision := greatest(least(coalesce(agent_confidence, 0), 1), 0);
  -- Only user-delegated AI reads score. search indexing and corpus crawling
  -- are infrastructure passing by, not attention — one bulk crawl would hit
  -- every record at once and drown a single genuine read (Meta-ExternalAgent
  -- covered the whole archive in a minute). preview is the mechanical echo of
  -- a human share (someone pasted a link) — a human-adjacent signal, not
  -- machine interest. All are observed in machine_access / machine_events;
  -- none are scored. Non-200 responses (redirects) never score.
  score_delta double precision := case
    when normalized_category = 'ai' and coalesce(event_metadata->>'status', '200') = '200' then 0.30
    else 0
  end * clamped_confidence;
  updated_record public.archive_records%rowtype;
begin
  if record_slug is not null then
    update public.archive_records
    set
      machine_access = machine_access + 1,
      machine_score = machine_score + score_delta,
      last_event_at = now(),
      updated_at = now()
    where slug = record_slug
    returning * into updated_record;
  end if;

  insert into public.machine_events (record_slug, path, agent, category, confidence, user_agent, metadata)
  values (
    updated_record.slug,
    event_path,
    coalesce(agent_name, 'Unknown'),
    normalized_category,
    clamped_confidence,
    agent_user_agent,
    coalesce(event_metadata, '{}'::jsonb)
  );

  return jsonb_build_object(
    'slug', updated_record.slug,
    'category', normalized_category,
    'machineAccess', updated_record.machine_access,
    'machineScore', updated_record.machine_score
  );
end;
$$;

grant execute on function public.record_machine_event(text, text, text, double precision, text, text, jsonb) to anon, authenticated;

-- Scores are interpretations derived from machine_events observations; when
-- the weight policy changes, rebuild them from the raw log instead of trying
-- to patch accumulated deltas. Service-role only (no grants) — run manually
-- from the SQL editor after a policy change: select public.recompute_machine_scores();
-- machine_score is the deduplicated interpretation: one (agent, record, UTC
-- day) group counts once regardless of how many times the fetch repeated
-- within a conversation, scored at the group's highest confidence ("that day
-- this agent showed interest in this record, and this is how sure we are of
-- the classification"). machine_access stays the raw cumulative fetch count —
-- the two deliberately diverge (a 4-fetch burst is access +4, score +0.30).
-- Daytime RPC increments are provisional; the nightly sleep rebuild calls
-- this to canonicalize the score from raw machine_events.
create or replace function public.recompute_machine_scores()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  affected integer;
begin
  -- machine_score carries two evidence classes:
  --   1) direct user-delegated AI reads (path ①): machine_events 'ai' rows,
  --      one unit per (agent, record, UTC day) at the group's best confidence.
  --   2) AI-referred human arrivals — the moment path-② demand becomes
  --      observable: a page_view whose referrer or utm_source names an AI
  --      service means the AI cited this record and a human followed. One
  --      unit per (session, record); the session is already the time unit.
  --      Hard to fake: the AI has to cite the record first.
  update public.archive_records r
  set machine_score = coalesce((
    select sum(0.30 * grp.confidence)
    from (
      select max(greatest(least(coalesce(e.confidence, 0), 1), 0)) as confidence
      from public.machine_events e
      where e.record_slug = r.slug
        and e.category = 'ai'
        and coalesce(e.metadata->>'status', '200') = '200'
      group by e.agent, (e.created_at at time zone 'utc')::date
    ) grp
  ), 0) + coalesce((
    select count(*) * 0.30
    from (
      select distinct e.session_id
      from public.archive_events e
      where e.record_slug = r.slug
        and e.event_type = 'page_view'
        and (
          e.referrer ~* '(chatgpt\.com|chat\.openai\.com|perplexity\.ai|gemini\.google\.com|copilot\.microsoft\.com|claude\.ai)'
          or coalesce(e.metadata->>'search', '') ~* 'utm_source=(chatgpt|openai|perplexity|gemini|copilot|claude)'
        )
    ) ref
  ), 0);
  get diagnostics affected = row_count;
  return affected;
end;
$$;

-- Postgres grants EXECUTE to PUBLIC on new functions by default; revoke so
-- this really is service-role only, as intended.
revoke execute on function public.recompute_machine_scores() from public, anon, authenticated;

-- Human scores get the symmetric treatment: repeated events within one visit
-- are access, not repeated interest. One (session, record, event_type) group
-- counts once. The session is both the actor and the time unit — it is an
-- ephemeral sessionStorage id that dies with the tab, so unlike the machine
-- side no day axis is needed: a returning visitor is a new session and a new
-- act of interest. Raw counters (views, tile_clicks, opens, page_views)
-- stay cumulative; only the score interpretations are rebuilt. Measured
-- before introduction, within-visit repeats were 13.5% of the total score.
create or replace function public.recompute_human_scores()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  affected integer;
begin
  update public.archive_records r
  set
    runtime_score = coalesce((
      select sum(case grp.event_type
        when 'tile_click' then 0.15
        when 'record_open' then 0.35
        when 'page_view' then 0.25
        else 0
      end)
      from (
        select distinct e.session_id, e.event_type
        from public.archive_events e
        where e.record_slug = r.slug
      ) grp
    ), 0),
    human_score = coalesce((
      select sum(case grp.event_type
        when 'tile_click' then 0.15
        when 'record_open' then 0.35
        else 0
      end)
      from (
        select distinct e.session_id, e.event_type
        from public.archive_events e
        where e.record_slug = r.slug
      ) grp
    ), 0);
  get diagnostics affected = row_count;
  return affected;
end;
$$;

revoke execute on function public.recompute_human_scores() from public, anon, authenticated;

-- Report layer: read-time interpretations computed on demand from the raw
-- machine_events log. Nothing is stored — when reading rules change, the next
-- run just reflects them. Service-role only; run from the SQL editor:
--   select * from public.report_machine_cadence();
--   select * from public.report_machine_record_refresh();
-- Reading caveats (docs/MACHINE_ATTENTION_SEMANTICS.md):
--   * This is the cadence of self-identifying fetchers only — a lower bound.
--     Invisible fetchers (browser-UA, unverified) leave no rows at all.
--   * Never compare cadence across services: a path-① service (live fetch)
--     necessarily looks busier here than a path-② service (index-based).
--     That difference is measurement surface, not visit frequency.
--   * For 'unknown' rows the agent is a tool name (python-httpx, curl), not
--     an operator. Operator attribution stays in metadata (asOrganization,
--     xCaller) and is interpreted at analysis time, not aggregated here.
--   * All response statuses count as visits — a 404 crawl attempt is still
--     cadence evidence. Filter on metadata->>'status' ad hoc if needed.

-- Per (agent, category): events grouped into visits (bursts separated by more
-- than session_gap_minutes of silence), then visit cadence and batch shape.
-- "Batch" answers: when this agent comes, how much does it take in one pass?
-- "Cadence" answers: how long between passes?
drop function if exists public.report_machine_cadence(integer);

create or replace function public.report_machine_cadence(
  session_gap_minutes integer default 30
)
returns table (
  agent text,
  category text,
  fetches bigint,
  records_covered bigint,
  active_days bigint,
  first_seen timestamptz,
  last_seen timestamptz,
  visits bigint,
  median_visit_gap interval,
  median_batch_fetches double precision,
  max_batch_fetches bigint,
  median_batch_span interval
)
language sql
stable
security definer
set search_path = public
as $$
  with ordered as (
    select e.agent, e.category, e.id, e.created_at, e.record_slug,
      lag(e.created_at) over (partition by e.agent, e.category order by e.created_at, e.id) as prev_at
    from public.machine_events e
  ),
  flagged as (
    select *,
      case
        when prev_at is null
          or created_at - prev_at > make_interval(mins => session_gap_minutes)
        then 1 else 0
      end as is_new_visit
    from ordered
  ),
  numbered as (
    select *,
      sum(is_new_visit) over (partition by agent, category order by created_at, id) as visit_no
    from flagged
  ),
  per_visit as (
    select agent, category, visit_no,
      min(created_at) as visit_start,
      max(created_at) as visit_end,
      count(*) as batch_fetches
    from numbered
    group by agent, category, visit_no
  ),
  with_gaps as (
    select *,
      visit_start - lag(visit_end) over (partition by agent, category order by visit_start) as gap
    from per_visit
  ),
  totals as (
    select e.agent, e.category,
      count(*) as fetches,
      count(distinct e.record_slug) as records_covered,
      count(distinct (e.created_at at time zone 'utc')::date) as active_days,
      min(e.created_at) as first_seen,
      max(e.created_at) as last_seen
    from public.machine_events e
    group by e.agent, e.category
  ),
  visit_stats as (
    select agent, category,
      count(*) as visits,
      percentile_cont(0.5) within group (order by gap) as median_visit_gap,
      percentile_cont(0.5) within group (order by batch_fetches::double precision) as median_batch_fetches,
      max(batch_fetches) as max_batch_fetches,
      percentile_cont(0.5) within group (order by visit_end - visit_start) as median_batch_span
    from with_gaps
    group by agent, category
  )
  select
    t.agent, t.category,
    t.fetches, t.records_covered, t.active_days, t.first_seen, t.last_seen,
    v.visits, v.median_visit_gap,
    v.median_batch_fetches, v.max_batch_fetches, v.median_batch_span
  from totals t
  join visit_stats v using (agent, category)
  order by t.fetches desc;
$$;

revoke execute on function public.report_machine_cadence(integer) from public, anon, authenticated;

-- Per (agent, record): how often the same agent comes back for the same
-- record, at UTC-day granularity — same-day repeats are batch behavior, not a
-- refresh, mirroring the (agent, record, UTC day) canonicalization rule. This
-- is the observable half of any future freshness experiment: edit a record,
-- then read here how long the visible fetchers take to return for it.
drop function if exists public.report_machine_record_refresh(integer);

create or replace function public.report_machine_record_refresh(
  min_fetch_days integer default 2
)
returns table (
  agent text,
  category text,
  record_slug text,
  fetches bigint,
  fetch_days bigint,
  first_fetch timestamptz,
  last_fetch timestamptz,
  median_refresh_days double precision,
  max_refresh_days integer
)
language sql
stable
security definer
set search_path = public
as $$
  with day_hits as (
    select e.agent, e.category, e.record_slug,
      (e.created_at at time zone 'utc')::date as day,
      count(*) as day_fetches,
      min(e.created_at) as first_at,
      max(e.created_at) as last_at
    from public.machine_events e
    where e.record_slug is not null
    group by e.agent, e.category, e.record_slug, (e.created_at at time zone 'utc')::date
  ),
  gaps as (
    select *,
      day - lag(day) over (partition by agent, category, record_slug order by day) as gap_days
    from day_hits
  )
  select agent, category, record_slug,
    sum(day_fetches) as fetches,
    count(*) as fetch_days,
    min(first_at) as first_fetch,
    max(last_at) as last_fetch,
    percentile_cont(0.5) within group (order by gap_days::double precision) as median_refresh_days,
    max(gap_days) as max_refresh_days
  from gaps
  group by agent, category, record_slug
  having count(*) >= min_fetch_days
  order by fetch_days desc, fetches desc;
$$;

revoke execute on function public.report_machine_record_refresh(integer) from public, anon, authenticated;
