# Ydnil-poh Archive Field

A personal archive field built around semantic density, spatial memory, and AI-readable records.

This is not a blog feed. The homepage is the archive surface itself: a quiet semantic terrain where records gather, compress, and drift slowly through nightly rebuilds.

## Writing Source

Records live in:

```txt
src/content/records/*.md
```

This folder is intended to be used from Obsidian. Write normal Markdown notes there and keep frontmatter lightweight.

Required frontmatter:

```yaml
title: Example record
date: 2026-05-23
location: Seoul
excerpt: Short human-readable summary
tags: [archive, memory]
```

Optional frontmatter:

```yaml
cover: https://YOUR_PROJECT.supabase.co/storage/v1/object/public/archive-images/example.jpg
coverAlt: image description
type: writing # writing | image | place | idea | note
visibility: public # public | private
manualCluster: 3
manualScore: 0.72
source: obsidian
views: 0
```

`trackbacks` is not used.

## Images

Supabase Storage is the official image store.

Recommended bucket:

```txt
archive-images
```

Upload from your local environment:

```bash
SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=YOUR_SERVICE_ROLE_KEY \
npm run upload:image -- ./path/to/image.jpg
```

The command prints Markdown image syntax that can be pasted into an Obsidian note.

## Archive Manifest

The build generates:

```txt
public/archive-manifest.json
```

The manifest is public and intended for AI agents. It includes record metadata, image URLs, score, cluster, position, related IDs, content hash, and embedding status.

Generate it locally:

```bash
npm run manifest
```

Build the site:

```bash
npm run build
```

## Supabase Vector

Use `supabase/archive-schema.sql` as the starting database schema.

It defines:

- `archive_records`
- `archive_embeddings`
- `archive_relations`
- `archive_events`
- `record_archive_event(record_slug text, event_type text, event_metadata jsonb)`
- `increment_record_view(record_slug text)` compatibility wrapper

The current site works without Supabase credentials. When credentials are present, field tile clicks, detail opens, and record page views are written to Supabase immediately, while semantic density and layout changes remain part of the static/nightly rebuild path.

## Deployment

GitHub Actions deploys to GitHub Pages on push, manual dispatch, and nightly schedule.

Required repository secrets for full Supabase behavior:

```txt
PUBLIC_SUPABASE_URL
PUBLIC_SUPABASE_ANON_KEY
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
```

The archive should remain stable. Rebuilds should feel like slow sediment and local drift, not a reshuffled feed.
