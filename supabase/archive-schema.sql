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
add column if not exists last_event_at timestamptz;

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
  category text not null check (category in ('search', 'crawler', 'ai', 'unknown')),
  confidence double precision not null default 0,
  user_agent text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

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
    when agent_category in ('search', 'crawler', 'ai') then agent_category
    else 'unknown'
  end;
  clamped_confidence double precision := greatest(least(coalesce(agent_confidence, 0), 1), 0);
  -- search indexing is bookkeeping, not attention; it is observed but not scored.
  score_delta double precision := case normalized_category
    when 'ai' then 0.30
    when 'crawler' then 0.10
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
