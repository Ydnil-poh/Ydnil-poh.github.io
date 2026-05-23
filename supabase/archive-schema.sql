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
  updated_at timestamptz not null default now()
);

create table if not exists public.archive_embeddings (
  record_slug text primary key references public.archive_records(slug) on delete cascade,
  embedding vector(1536),
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

alter table public.archive_records enable row level security;
alter table public.archive_embeddings enable row level security;
alter table public.archive_relations enable row level security;

create policy "public read archive records"
on public.archive_records
for select
using (true);

create policy "public read archive relations"
on public.archive_relations
for select
using (true);

create or replace function public.increment_record_view(record_slug text)
returns void
language plpgsql
security definer
as $$
begin
  insert into public.archive_records (slug, title, views)
  values (record_slug, record_slug, 1)
  on conflict (slug)
  do update set views = public.archive_records.views + 1;
end;
$$;
