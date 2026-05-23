import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const recordsDir = path.join(root, 'src', 'content', 'records');
const outputPath = path.join(root, 'public', 'archive-manifest.json');
const supabaseUrl = process.env.SUPABASE_URL ?? process.env.PUBLIC_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const markdownExtensions = new Set(['.md', '.markdown', '.mdx']);

async function listMarkdownFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files = await Promise.all(entries.map(async (entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return listMarkdownFiles(fullPath);
    if (markdownExtensions.has(path.extname(entry.name))) return [fullPath];
    return [];
  }));
  return files.flat();
}

function parseFrontmatter(raw) {
  if (!raw.startsWith('---')) return { data: {}, body: raw };
  const end = raw.indexOf('\n---', 3);
  if (end === -1) return { data: {}, body: raw };

  const block = raw.slice(3, end).trim();
  const body = raw.slice(end + 4).trim();
  const data = {};

  for (const line of block.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    const value = rawValue.trim();
    if (value.startsWith('[') && value.endsWith(']')) {
      data[key] = value.slice(1, -1).split(',').map((item) => item.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
    } else if (/^\d+(\.\d+)?$/.test(value)) {
      data[key] = Number(value);
    } else {
      data[key] = value.replace(/^['"]|['"]$/g, '');
    }
  }

  return { data, body };
}

function slugFromFile(file) {
  return path.relative(recordsDir, file).replace(/\\/g, '/').replace(/\.(md|markdown|mdx)$/i, '');
}

function extractImages(body, cover) {
  const markdownImages = [...body.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((match) => match[1]);
  const htmlImages = [...body.matchAll(/<img\b[^>]*src=['"]([^'"]+)['"][^>]*>/gi)].map((match) => match[1]);
  return [cover, ...markdownImages, ...htmlImages].filter(Boolean);
}

function normalizeScore(value, min, max) {
  if (max <= min) return 0.5;
  return Number(((value - min) / (max - min)).toFixed(4));
}

function clusterFor(record, index) {
  if (Number.isFinite(record.manualCluster)) return record.manualCluster;
  const seed = [record.location, ...(record.tags ?? [])].join('|') || record.id;
  const hash = createHash('sha1').update(seed).digest('hex');
  return Number.parseInt(hash.slice(0, 4), 16) % Math.max(4, Math.ceil(Math.sqrt(index + 4)) + 3);
}

function positionFor(record, index, total) {
  const hash = createHash('sha1').update(`${record.id}:${record.cluster}`).digest();
  const angle = (hash[0] / 255) * Math.PI * 2;
  const band = 0.12 + ((index + 1) / Math.max(total, 1)) * 0.76;
  const gravity = 0.18 * record.score;
  const radius = Math.max(0.1, Math.min(0.92, band - gravity));
  const x = 0.5 + Math.cos(angle) * radius * 0.46;
  const y = 0.5 + Math.sin(angle) * radius * 0.36;
  return { x: Number(x.toFixed(4)), y: Number(y.toFixed(4)) };
}

function related(records, source) {
  return records
    .filter((candidate) => candidate.id !== source.id)
    .map((candidate) => {
      const sharedTags = candidate.tags.filter((tag) => source.tags.includes(tag)).length;
      const location = candidate.location === source.location ? 1 : 0;
      const cluster = candidate.cluster === source.cluster ? 1 : 0;
      return { id: candidate.id, weight: sharedTags * 2 + location + cluster };
    })
    .filter((item) => item.weight > 0)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 8)
    .map((item) => item.id);
}

async function supabaseUpsert(table, rows, onConflict) {
  if (!supabaseUrl || !supabaseServiceKey || rows.length === 0) return false;

  const endpoint = `${supabaseUrl.replace(/\/$/, '')}/rest/v1/${table}?on_conflict=${encodeURIComponent(onConflict)}`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      apikey: supabaseServiceKey,
      Authorization: `Bearer ${supabaseServiceKey}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates',
    },
    body: JSON.stringify(rows),
  });

  if (!response.ok) {
    throw new Error(`Supabase ${table} sync failed: ${response.status} ${await response.text()}`);
  }

  return true;
}

async function syncSupabase(records) {
  if (!supabaseUrl || !supabaseServiceKey) {
    console.log('supabase sync skipped: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not set');
    return;
  }

  const recordRows = records.map((record) => ({
    slug: record.id,
    title: record.title,
    body_digest: record.contentHash,
    metadata: {
      date: record.date,
      location: record.location,
      type: record.type,
      excerpt: record.excerpt,
      tags: record.tags,
      cover: record.cover,
      coverAlt: record.coverAlt,
      imageUrls: record.imageUrls,
      url: record.url,
      embedding: record.embedding,
    },
    score: record.score,
    cluster: record.cluster,
    position: record.position,
    updated_at: new Date().toISOString(),
  }));

  const relationRows = records.flatMap((record) => record.related.map((targetId) => ({
    source_slug: record.id,
    target_slug: targetId,
    cosine_distance: 1,
    relation_weight: 1,
    updated_at: new Date().toISOString(),
  })));

  await supabaseUpsert('archive_records', recordRows, 'slug');
  await supabaseUpsert('archive_relations', relationRows, 'source_slug,target_slug');
  console.log(`supabase sync complete: ${recordRows.length} records, ${relationRows.length} relations`);
}

const files = await listMarkdownFiles(recordsDir);
const initial = await Promise.all(files.map(async (file) => {
  const raw = await readFile(file, 'utf8');
  const { data, body } = parseFrontmatter(raw);
  const text = body.replace(/<[^>]+>/g, '').replace(/!\[[^\]]*\]\([^)]*\)/g, '').trim();
  const images = extractImages(body, data.cover);
  const contentHash = createHash('sha256').update(`${JSON.stringify(data)}\n${body}`).digest('hex');
  const rawScore = Number.isFinite(data.manualScore)
    ? data.manualScore
    : text.replace(/\s/g, '').length * 0.08 + images.length * 14 + (data.views ?? 0) * 0.8 + (data.tags?.length ?? 0) * 6;

  return {
    id: slugFromFile(file),
    title: data.title ?? slugFromFile(file),
    date: data.date ?? '',
    location: data.location ?? '',
    type: data.type ?? (images.length > 0 ? 'image' : 'writing'),
    visibility: data.visibility ?? 'public',
    excerpt: data.excerpt ?? text.slice(0, 140),
    tags: data.tags ?? [],
    cover: data.cover ?? '',
    coverAlt: data.coverAlt ?? 'archive image',
    source: data.source ?? '',
    manualCluster: data.manualCluster,
    manualScore: data.manualScore,
    imageUrls: images,
    textLength: text.replace(/\s/g, '').length,
    contentHash,
    rawScore,
  };
}));

const publicRecords = initial.filter((record) => record.visibility !== 'private');
const min = Math.min(...publicRecords.map((record) => record.rawScore), 0);
const max = Math.max(...publicRecords.map((record) => record.rawScore), 1);

const scored = publicRecords.map((record, index) => ({
  ...record,
  score: Number.isFinite(record.manualScore) ? Number(record.manualScore.toFixed(4)) : normalizeScore(record.rawScore, min, max),
  cluster: clusterFor(record, index),
}));

const positioned = scored.map((record, index) => ({
  ...record,
  position: positionFor(record, index, scored.length),
}));

const records = positioned.map((record) => ({
  id: record.id,
  slug: record.id,
  title: record.title,
  date: record.date,
  location: record.location,
  type: record.type,
  excerpt: record.excerpt,
  tags: record.tags,
  cover: record.cover,
  coverAlt: record.coverAlt,
  score: record.score,
  cluster: record.cluster,
  position: record.position,
  related: related(positioned, record),
  imageUrls: record.imageUrls,
  contentHash: record.contentHash,
  embedding: {
    provider: 'supabase-vector',
    status: process.env.SUPABASE_URL ? 'external' : 'pending',
    model: process.env.EMBEDDING_MODEL ?? null,
  },
  url: `/records/${record.id}/`,
}));

const manifest = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  source: 'src/content/records',
  storage: { provider: 'supabase', bucket: process.env.SUPABASE_STORAGE_BUCKET ?? 'archive-images' },
  vector: { provider: 'supabase-vector', table: 'archive_embeddings', relationTable: 'archive_relations' },
  spatialPolicy: {
    interpretation: 'semantic density terrain',
    scoreMeaning: ['memory cohesion', 'semantic recurrence', 'relation density', 'revisit potential'],
    persistence: 'nightly rebuilds should preserve spatial memory and allow only local drift',
  },
  counts: {
    records: records.length,
    images: records.reduce((sum, record) => sum + record.imageUrls.length, 0),
    clusters: new Set(records.map((record) => record.cluster)).size,
  },
  records,
};

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`archive manifest written: ${path.relative(root, outputPath)} (${records.length} records)`);
await syncSupabase(records);
