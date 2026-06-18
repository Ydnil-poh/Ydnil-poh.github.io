import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateFieldViewModel } from '../src/lib/archive/fieldViewModel.mjs';
import { generateTextureViewModel } from '../src/lib/archive/texturePipeline.mjs';
import { textureOpacityByValue } from '../src/lib/archive/textureRenderContract.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const recordsDir = path.join(root, 'src', 'content', 'records');
const outputPath = path.join(root, 'public', 'archive-manifest.json');
const debugLayoutPath = path.join(root, 'public', 'archive-layout-debug.json');
const supabaseUrl = process.env.SUPABASE_URL ?? process.env.PUBLIC_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseStorageBucket = process.env.SUPABASE_STORAGE_BUCKET ?? 'img';
const embeddingDimensions = 64;
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
  return path
    .relative(recordsDir, file)
    .replace(/\\/g, '/')
    .replace(/\.(md|markdown|mdx)$/i, '')
    .toLowerCase();
}

function plainText(body) {
  return body
    .replace(/<[^>]+>/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]+\)/g, ' ')
    .replace(/[`*_>#\-[\]()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractImages(body) {
  const markdownImages = [...body.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((match) => match[1]);
  const htmlImages = [...body.matchAll(/<img\b[^>]*src=['"]([^'"]+)['"][^>]*>/gi)].map((match) => match[1]);
  return [...markdownImages, ...htmlImages].filter(Boolean);
}

function normalizeStorageFolder(folder) {
  return String(folder ?? '').trim().replace(/^\/+|\/+$/g, '');
}

function naturalCompare(a, b) {
  return new Intl.Collator('en', { numeric: true, sensitivity: 'base' }).compare(a, b);
}

function publicStorageUrl(folder, name) {
  const objectPath = [folder, name]
    .filter(Boolean)
    .join('/')
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `${supabaseUrl.replace(/\/$/, '')}/storage/v1/object/public/${encodeURIComponent(supabaseStorageBucket)}/${objectPath}`;
}

async function listStorageImages(folder) {  
  const normalizedFolder = normalizeStorageFolder(folder);
  if (!supabaseUrl || !supabaseServiceKey || !normalizedFolder) return [];

  const endpoint = `${supabaseUrl.replace(/\/$/, '')}/storage/v1/object/list/${encodeURIComponent(supabaseStorageBucket)}`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      apikey: supabaseServiceKey,
      Authorization: `Bearer ${supabaseServiceKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      prefix: normalizedFolder,
      limit: 1000,
      offset: 0,
      sortBy: { column: 'name', order: 'asc' },
    }),
  });

  if (!response.ok) {
    console.warn(`storage list skipped for ${normalizedFolder}: ${response.status} ${await response.text()}`);
    return [];
  }

  const objects = await response.json();

  console.log(
    '[gallery]',
    normalizedFolder,
    JSON.stringify(objects, null, 2)
  );  
  
  return objects
    .filter((object) => 
      object?.metadata?.mimetype?.startsWith('image/')
    )
    .map((object) => object.name)
    .sort(naturalCompare)
    .map((name) => publicStorageUrl(normalizedFolder, name));
}

function tokensFor(text) {
  const latin = text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [];
  const hangul = text.match(/[가-힣]{2,}/g) ?? [];
  const hangulNgrams = hangul.flatMap((word) => {
    const chars = [...word];
    if (chars.length <= 3) return [word];
    return chars.slice(0, -2).map((_, index) => chars.slice(index, index + 3).join(''));
  });
  return [...latin, ...hangul, ...hangulNgrams];
}

function hashToken(token) {
  const hash = createHash('sha1').update(token).digest();
  return { index: hash[0] % embeddingDimensions, sign: hash[1] % 2 === 0 ? 1 : -1 };
}

function embeddingFor(text) {
  const vector = Array.from({ length: embeddingDimensions }, () => 0);
  for (const token of tokensFor(text)) {
    const { index, sign } = hashToken(token);
    vector[index] += sign;
  }
  const magnitude = Math.hypot(...vector) || 1;
  return vector.map((value) => Number((value / magnitude).toFixed(6)));
}

function cosineSimilarity(a, b) {
  return a.reduce((sum, value, index) => sum + value * b[index], 0);
}

function normalizeScore(value, min, max) {
  if (max <= min) return 0.5;
  return Number(((value - min) / (max - min)).toFixed(4));
}


function projectEmbeddings(records) {
  if (records.length === 0) return new Map();

  const dimensions = records[0].embedding.length;

  const variance = Array(dimensions).fill(0);
  const mean = Array(dimensions).fill(0);

  for (const record of records) {
    for (let i = 0; i < dimensions; i++) {
      mean[i] += record.embedding[i];
    }
  }

  for (let i = 0; i < dimensions; i++) {
    mean[i] /= records.length;
  }

  for (const record of records) {
    for (let i = 0; i < dimensions; i++) {
      const diff = record.embedding[i] - mean[i];
      variance[i] += diff * diff;
    }
  }

  const ranked = variance
    .map((value, index) => ({ value, index }))
    .sort((a, b) => b.value - a.value);

  const xAxis = ranked[0]?.index ?? 0;
  const yAxis = ranked[1]?.index ?? 1;

  const xs = records.map((record) => record.embedding[xAxis]);
  const ys = records.map((record) => record.embedding[yAxis]);

  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);

  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);

  const positions = new Map();

  records.forEach((record) => {
    const x =
      maxX === minX
        ? 0.5
        : (record.embedding[xAxis] - minX) / (maxX - minX);

    const y =
      maxY === minY
        ? 0.5
        : (record.embedding[yAxis] - minY) / (maxY - minY);

    positions.set(record.id, { x, y });
  });

  return positions;
}

function decoratePosition(
  record,
  basePosition,
  attentionDriftScale,
) {
  const hash = createHash('sha1')
    .update(record.id)
    .digest();

  const jitterX = (hash[0] / 255 - 0.5) * 0.08;
  const jitterY = (hash[1] / 255 - 0.5) * 0.08;

  const activity =
    attentionDriftScale <= 0
      ? 0
      : Math.log1p(record.attentionSnapshot.humanScore) /
        attentionDriftScale;

  const driftX =
    (hash[2] / 255 - 0.5) *
    activity *
    0.035;

  const driftY =
    (hash[3] / 255 - 0.5) *
    activity *
    0.035;

  const x =
    0.1 +
    basePosition.x * 0.8 +
    jitterX +
    driftX;

  const y =
    0.1 +
    basePosition.y * 0.8 +
    jitterY +
    driftY;

  return {
    x: Number(Math.max(0.08, Math.min(0.92, x)).toFixed(4)),
    y: Number(Math.max(0.08, Math.min(0.92, y)).toFixed(4)),
  };
}

function relationRows(records, source) {
  return records
    .filter((candidate) => candidate.id !== source.id)
    .map((candidate) => {
      const similarity = Math.max(
        0,
        cosineSimilarity(source.embedding, candidate.embedding)
      );

      const cosineDistance = Number(
        Math.max(0, Math.min(2, 1 - similarity)).toFixed(4)
      );

      const sharedTags = candidate.tags.filter(
        (tag) => source.tags.includes(tag)
      ).length;

      const relationWeight = Number(
        (sharedTags + similarity * 0.2).toFixed(4)
      );

      return {
        id: candidate.id,
        cosineDistance,
        relationWeight,
      };
    })
    .filter((relation) => relation.relationWeight > 0)
    .sort((a, b) => b.relationWeight - a.relationWeight)
    .slice(0, 8);
}

function emptyAttentionSnapshot() {
  return {
    views: 0,
    tileClicks: 0,
    opens: 0,
    pageViews: 0,
    runtimeScore: 0,
    humanModalOpen: 0,
    humanFullOpen: 0,
    humanScore: 0,
    machineAccess: 0,
    machineScore: 0,
    lastEventAt: null,
  };
}

function semanticDensityFor(record) {
  const topRelations = record.relations.slice(0, 4);
  const relationDensity = topRelations.length === 0
    ? 0
    : topRelations.reduce((sum, relation) => sum + Math.max(0, relation.relationWeight), 0) / topRelations.length;
  const recurrence = Math.min(1, tokensFor([record.title, record.excerpt].join(' ')).length / 36);
  return Number((relationDensity * 0.72 + recurrence * 0.28).toFixed(6));
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
  if (!response.ok) throw new Error(`Supabase ${table} sync failed: ${response.status} ${await response.text()}`);
  return true;
}

async function fetchAttentionSnapshots(ids) {
  if (!supabaseUrl || !supabaseServiceKey || ids.length === 0) return new Map();
  const quoted = ids.map((id) => `"${String(id).replaceAll('\"', '\\"')}"`).join(',');
  const endpoint = `${supabaseUrl.replace(/\/$/, '')}/rest/v1/archive_records?select=slug,views,tile_clicks,opens,page_views,runtime_score,human_modal_open,human_full_open,human_score,machine_access,machine_score,last_event_at&slug=in.(${quoted})`;
  const response = await fetch(endpoint, {
    headers: {
      apikey: supabaseServiceKey,
      Authorization: `Bearer ${supabaseServiceKey}`,
    },
  });
  if (!response.ok) {
    console.warn(`attention metrics fetch skipped: ${response.status} ${await response.text()}`);
    return new Map();
  }
  const rows = await response.json();
  return new Map(rows.map((row) => [row.slug, {
    views: Number(row.views ?? 0),
    tileClicks: Number(row.tile_clicks ?? 0),
    opens: Number(row.opens ?? 0),
    pageViews: Number(row.page_views ?? 0),
    runtimeScore: Number(row.runtime_score ?? 0),
    humanModalOpen: Number(row.human_modal_open ?? row.tile_clicks ?? 0),
    humanFullOpen: Number(row.human_full_open ?? row.opens ?? 0),
    humanScore: Number(row.human_score ?? row.runtime_score ?? 0),
    machineAccess: Number(row.machine_access ?? 0),
    machineScore: Number(row.machine_score ?? 0),
    lastEventAt: row.last_event_at ?? null,
  }]));
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
      imageUrls: record.imageUrls,
      galleryFolder: record.galleryFolder,
      galleryImageUrls: record.galleryImageUrls,
      url: record.url,
      embeddingRef: record.embeddingRef,
      embeddingModel: record.embeddingModel,
    },
    score: record.score,
    position: record.position,
    updated_at: new Date().toISOString(),
  }));
  const embeddingRows = records.map((record) => ({
    record_slug: record.id,
    embedding: `[${record.embedding.join(',')}]`,
    model: record.embeddingModel,
    content_hash: record.contentHash,
    updated_at: new Date().toISOString(),
  }));
  const relationRowsForSync = records.flatMap((record) => record.relations.map((relation) => ({
    source_slug: record.id,
    target_slug: relation.id,
    cosine_distance: relation.cosineDistance,
    relation_weight: relation.relationWeight,
    updated_at: new Date().toISOString(),
  })));
  await supabaseUpsert('archive_records', recordRows, 'slug');
  await supabaseUpsert('archive_embeddings', embeddingRows, 'record_slug');
  await supabaseUpsert('archive_relations', relationRowsForSync, 'source_slug,target_slug');
  console.log(`supabase sync complete: ${recordRows.length} records, ${embeddingRows.length} embeddings, ${relationRowsForSync.length} relations`);
}

const files = await listMarkdownFiles(recordsDir);
const initial = await Promise.all(files.map(async (file) => {
  const raw = await readFile(file, 'utf8');
  const { data, body } = parseFrontmatter(raw);
  const text = plainText(body);
  const images = extractImages(body);
  const galleryFolder = normalizeStorageFolder(data.galleryFolder);
  const galleryImageUrls = await listStorageImages(galleryFolder);
  const normalizedType = data.type === 'mediaRail' ? 'mediaRail' : 'standard';
  const searchableText = [data.title, data.excerpt, data.location, normalizedType, text].filter(Boolean).join('\n');
  const embedding = embeddingFor(searchableText);
  const contentHash = createHash('sha256').update(`${JSON.stringify(data)}\n${body}`).digest('hex');

  return {
    id: slugFromFile(file),
    title: data.title ?? slugFromFile(file),
    date: data.date ?? '',
    location: data.location ?? '',
    type: normalizedType,
    visibility: data.visibility ?? 'public',
    excerpt: data.excerpt ?? text.slice(0, 140),
    tags: data.tags ?? [],
    source: data.source ?? '',
    imageUrls: images,
    galleryFolder,
    galleryImageUrls,
    textLength: text.replace(/\s/g, '').length,
    rawBody: body,
    contentHash,
    embedding,
    embeddingModel: `local-feature-hash-ko-en-${embeddingDimensions}`,
    manualSemanticScore: data.semanticScore,
  };
}));

const publicRecords = initial.filter((record) => record.visibility !== 'private');
const attentionSnapshots = await fetchAttentionSnapshots(publicRecords.map((record) => record.id));
const recordsWithAttention = publicRecords.map((record) => ({
  ...record,
  attentionSnapshot: attentionSnapshots.get(record.id) ?? emptyAttentionSnapshot(),
}));
const attentionDriftScale = Math.max(...recordsWithAttention.map((record) => Math.log1p(record.attentionSnapshot.humanScore)), 0);
const recordsWithRelations = recordsWithAttention.map((record) => ({ ...record, relations: relationRows(recordsWithAttention, record) }));
const densityValues = recordsWithRelations.map(semanticDensityFor);
const densityMin = Math.min(...densityValues, 0);
const densityMax = Math.max(...densityValues, 1);

const scored = recordsWithRelations.map((record, index) => ({
  ...record,
  score: Number.isFinite(record.manualSemanticScore) ? Number(record.manualSemanticScore.toFixed(4)) : normalizeScore(densityValues[index], densityMin, densityMax),
}));

const projectedPositions = projectEmbeddings(scored);

const semanticRecords = scored.map((record) => ({
  ...record,
  position: decoratePosition( record, projectedPositions.get(record.id), attentionDriftScale ),
  embeddingRef: {
    provider: 'supabase',
    table: 'archive_embeddings',
    key: record.id,
  },
  url: `/records/${record.id}/`,
}));

const recordsWithTexture = semanticRecords.map((record) => {
  const textureViewModel = generateTextureViewModel(record, plainText);
  return {
    ...record,
    textureViewModel,
  };
});

const textureDebugRecords = recordsWithTexture.map((record) => ({
  id: record.id,
  semanticBlocks: record.textureViewModel.debug.semanticBlocks,
  layoutGraph: record.textureViewModel.debug.layoutGraph,
}));

const records = recordsWithTexture.map((record) => ({
  id: record.id,
  slug: record.id,
  title: record.title,
  date: record.date,
  location: record.location,
  type: record.type,
  excerpt: record.excerpt,
  tags: record.tags,
  displayDensity: record.score,
  score: record.score,
  scoreMeaning: 'semantic density',
  position: record.position,
  related: record.relations.map((relation) => relation.id),
  relationSummary: record.relations.slice(0, 4).map((relation) => ({
    id: relation.id,
    weight: relation.relationWeight,
  })),
  attentionSnapshot: {
    ...record.attentionSnapshot,
    semantics: 'nightly snapshot only; source of truth remains Supabase archive_events/archive_records',
  },
  texture: record.textureViewModel.texture,
  imageUrls: record.imageUrls,
  galleryFolder: record.galleryFolder,
  galleryImageUrls: record.galleryImageUrls,
  contentHash: record.contentHash,
  embeddingRef: record.embeddingRef,
  embeddingModel: record.embeddingModel,
  url: record.url,
}));

const archiveView = {
  field: generateFieldViewModel(records),
};

const manifest = {
  schemaVersion: 6,
  generatedAt: new Date().toISOString(),
  source: 'src/content/records',
  storage: { provider: 'supabase', bucket: supabaseStorageBucket },
  semanticLayer: {
    provider: 'supabase-backed-nightly-precompute',
    embeddingModel: `local-feature-hash-ko-en-${embeddingDimensions}`,
    embeddingRef: { table: 'archive_embeddings', key: 'record_slug' },
    relationRef: { table: 'archive_relations', distance: 'cosine' },
    manifestPolicy: 'render snapshot only; raw vectors are excluded',
  },
  spatialPolicy: {
    interpretation: 'semantic density terrain',
    scoreMeaning: ['semantic density', 'recurrence', 'relational gravity', 'archival weight'],
    attentionSignal: 'human attention may cause weak nightly spatial drift but is not semantic gravity',
    excludes: ['raw embeddings', 'live views', 'engagement ranking', 'popularity'],
    persistence: 'nightly rebuilds should preserve spatial memory and allow only local drift',
  },
  analytics: {
    provider: 'supabase',
    table: 'archive_records',
    eventTable: 'archive_events',
    eventFunction: 'record_archive_event',
    sourceOfTruth: 'backend',
    frontmatterPolicy: 'ignored',
    snapshotSemantics: 'attention metrics in this manifest are frozen at rebuild time; live source of truth remains Supabase',
    rebuildUse: 'nightly attention metrics may weakly drift spatial placement but do not change semantic density directly',
  },
  counts: {
    records: records.length,
    images: records.reduce((sum, record) => sum + record.imageUrls.length + record.galleryImageUrls.length, 0),
  },
  archiveView,
  records,
};

await mkdir(path.dirname(outputPath), { recursive: true });
function formatManifestJson(value) {
  return JSON.stringify(value, null, 2)
    .replace(/\[\n(\s+)(-?\d+(?:\.\d+)?),\n\1(-?\d+(?:\.\d+)?)\n\s+\]/g, '[$2, $3]') + "\n";
}

const manifestJson = formatManifestJson(manifest);
await writeFile(outputPath, manifestJson);
await writeFile(debugLayoutPath, formatManifestJson({
  schemaVersion: 1,
  generatedAt: manifest.generatedAt,
  source: 'src/content/records',
  records: textureDebugRecords,
}));

const legacyTextureBytes = Buffer.byteLength(JSON.stringify(records.flatMap((record) => Object.values(record.texture.renders).map((render) => ({
  width: render.width,
  height: render.height,
  cells: render.rle.flatMap(([value, count]) => Array.from({ length: count }, () => textureOpacityByValue[value] ?? 0.05)),
})))));
const rleTextureBytes = Buffer.byteLength(JSON.stringify(records.flatMap((record) => Object.values(record.texture.renders).map((render) => ({
  width: render.width,
  height: render.height,
  encoding: render.encoding,
  rle: render.rle,
})))));
const textureReduction = legacyTextureBytes > 0
  ? ((1 - rleTextureBytes / legacyTextureBytes) * 100).toFixed(1)
  : '0.0';

console.log(`archive manifest written: ${path.relative(root, outputPath)} (${records.length} records, ${Buffer.byteLength(manifestJson)} bytes)`);
console.log(`archive layout debug written: ${path.relative(root, debugLayoutPath)} (${textureDebugRecords.length} records)`);
console.log(`texture encoding rle4: ${legacyTextureBytes} bytes legacy cells -> ${rleTextureBytes} bytes rle4 (${textureReduction}% smaller)`);
await syncSupabase(semanticRecords);
