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
  last_event_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.archive_records
add column if not exists tile_clicks integer not null default 0,
add column if not exists page_views integer not null default 0,
add column if not exists opens integer not null default 0,
add column if not exists runtime_score double precision not null default 0,
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

create table if not exists public.archive_embeddings (
  record_slug text primary key references public.archive_records(slug) on delete cascade,
  embedding vector(64),
  model text,
  content_hash text,
  updated_at timestamptz not null default now()
);

alter table public.archive_embeddings
alter column embedding type vector(64) using null::vector(64);

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

alter table public.archive_records enable row level security;
alter table public.archive_embeddings enable row level security;
alter table public.archive_relations enable row level security;
alter table public.archive_events enable row level security;

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

  insert into public.archive_records (slug, title, updated_at, last_event_at)
  values (record_slug, record_slug, now(), now())
  on conflict (slug) do nothing;

  insert into public.archive_events (record_slug, event_type, path, referrer, session_id, metadata)
  values (
    record_slug,
    normalized_event,
    payload->>'path',
    payload->>'referrer',
    payload->>'sessionId',
    payload
  );

  update public.archive_records
  set
    views = views + case when normalized_event in ('tile_click', 'record_open', 'page_view') then 1 else 0 end,
    tile_clicks = tile_clicks + case when normalized_event = 'tile_click' then 1 else 0 end,
    opens = opens + case when normalized_event = 'record_open' then 1 else 0 end,
    page_views = page_views + case when normalized_event = 'page_view' then 1 else 0 end,
    runtime_score = runtime_score + runtime_delta,
    last_event_at = now(),
    updated_at = now()
  where slug = record_slug
  returning * into updated_record;

  return jsonb_build_object(
    'slug', updated_record.slug,
    'views', updated_record.views,
    'tileClicks', updated_record.tile_clicks,
    'opens', updated_record.opens,
    'pageViews', updated_record.page_views,
    'runtimeScore', updated_record.runtime_score,
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
