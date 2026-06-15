import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const recordsDir = path.join(root, 'src', 'content', 'records');
const outputPath = path.join(root, 'public', 'archive-manifest.json');
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
  return objects
    .filter((object) => object?.name && !object.name.endsWith('/'))
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

function semanticCluster(record) {
  const strongest = record.embedding.reduce((best, value, index) => Math.abs(value) > Math.abs(record.embedding[best]) ? index : best, 0);
  return strongest % 8;
}

function positionFor(record, index, total, attentionDriftScale) {
  const xAxis = record.embedding[0] + record.embedding[2] * 0.6 + record.embedding[4] * 0.35;
  const yAxis = record.embedding[1] + record.embedding[3] * 0.6 + record.embedding[5] * 0.35;
  const hash = createHash('sha1').update(record.id).digest();
  const jitterX = (hash[0] / 255 - 0.5) * 0.08;
  const jitterY = (hash[1] / 255 - 0.5) * 0.08;
  const activity = attentionDriftScale <= 0 ? 0 : Math.log1p(record.attentionSnapshot.humanScore) / attentionDriftScale;
  const driftX = (hash[2] / 255 - 0.5) * activity * 0.035;
  const driftY = (hash[3] / 255 - 0.5) * activity * 0.035;
  const fallbackAngle = ((index + 1) / Math.max(total, 1)) * Math.PI * 2;
  const fallbackRadius = 0.12 + ((index % 5) * 0.035);
  const x = 0.5 + (xAxis || Math.cos(fallbackAngle) * fallbackRadius) * 0.34 + jitterX + driftX;
  const y = 0.5 + (yAxis || Math.sin(fallbackAngle) * fallbackRadius) * 0.3 + jitterY + driftY;
  return {
    x: Number(Math.max(0.08, Math.min(0.92, x)).toFixed(4)),
    y: Number(Math.max(0.08, Math.min(0.92, y)).toFixed(4)),
  };
}

function relationRows(records, source) {
  return records
    .filter((candidate) => candidate.id !== source.id)
    .map((candidate) => {
      const similarity = cosineSimilarity(source.embedding, candidate.embedding);
      const cosineDistance = Number(Math.max(0, Math.min(2, 1 - similarity)).toFixed(4));
      const relationWeight = Number(Math.max(0, similarity).toFixed(4));
      return { id: candidate.id, cosineDistance, relationWeight };
    })
    .sort((a, b) => a.cosineDistance - b.cosineDistance)
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

function isYoutubeDirective(block) {
  return /^!youtube\s+https?:\/\/(?:www\.)?(?:youtube\.com|youtu\.be)\//i.test(block.trim());
}

const textureOpacityByValue = [0.05, 0.24, 0.72, 0.85];

function quantizeTextureOpacity(opacity) {
  let closestValue = 0;
  let closestDistance = Infinity;

  for (let value = 0; value < textureOpacityByValue.length; value += 1) {
    const distance = Math.abs(opacity - textureOpacityByValue[value]);
    if (distance < closestDistance) {
      closestValue = value;
      closestDistance = distance;
    }
  }

  return closestValue;
}

function encodeRle4(values) {
  const rle = [];

  for (const value of values) {
    const previous = rle.at(-1);
    if (previous && previous[0] === value) {
      previous[1] += 1;
    } else {
      rle.push([value, 1]);
    }
  }

  return rle;
}

function generateTexture(record) {
  const width = 32;
  const height = 24;

  const margin = 4;
  const textWidth = width - margin * 2;
  const charsPerLine = textWidth;
  const youtubeBlockHeight = 4;

  const rows = [];

  for (const block of record.rawBody.split(/\n\s*\n/)) {
    if (isYoutubeDirective(block)) {
      for (let index = 0; index < youtubeBlockHeight; index += 1) {
        rows.push({ type: 'youtube', edge: index === 0 || index === youtubeBlockHeight - 1 });
      }
      rows.push({ type: 'space' });
      continue;
    }

    const paragraph = plainText(block);
    if (!paragraph) continue;

    let remaining = paragraph.length;

    while (remaining > 0) {
      rows.push({
        type: 'text',
        fillWidth: Math.min(charsPerLine, remaining),
      });

      remaining -= charsPerLine;
    }

    // 문단 간 공백
    rows.push({ type: 'space' });
  }

  if (rows.length > 0 && rows.at(-1).type === 'space') {
    rows.pop();
  }

  const quantizedCells = [];

  for (let y = 0; y < height; y++) {
    const row = rows[y] ?? { type: 'space' };

    for (let x = 0; x < width; x++) {
      if (row.type === 'text') {
        const insideText =
          row.fillWidth > 0 &&
          x >= margin &&
          x < margin + row.fillWidth;

        quantizedCells.push(quantizeTextureOpacity(insideText ? 0.85 : 0.05));
        continue;
      }

      if (row.type === 'youtube') {
        const insideMedia = x >= margin && x < margin + textWidth;
        const onVerticalEdge = x === margin || x === margin + textWidth - 1;
        const playMarker = !row.edge && x >= margin + 11 && x <= margin + 13;

        if (!insideMedia) {
          quantizedCells.push(quantizeTextureOpacity(0.05));
        } else if (row.edge || onVerticalEdge) {
          quantizedCells.push(quantizeTextureOpacity(0.72));
        } else if (playMarker) {
          quantizedCells.push(quantizeTextureOpacity(0.85));
        } else {
          quantizedCells.push(quantizeTextureOpacity(0.24));
        }
        continue;
      }

      quantizedCells.push(quantizeTextureOpacity(0.05));
    }
  }

  return {
    width,
    height,
    encoding: 'rle4',
    rle: encodeRle4(quantizedCells),
  };
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
    cluster: record.cluster,
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
  cluster: semanticCluster(record),
}));

const semanticRecords = scored.map((record, index) => ({
  ...record,
  position: positionFor(record, index, scored.length, attentionDriftScale),
  embeddingRef: {
    provider: 'supabase',
    table: 'archive_embeddings',
    key: record.id,
  },
  url: `/records/${record.id}/`,
}));

const records = semanticRecords.map((record) => ({
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
  cluster: record.cluster,
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
  texture: {
    density: record.score > 0.72 ? 'high' : record.score > 0.38 ? 'medium' : 'low',
    imageCount: record.imageUrls.length + record.galleryImageUrls.length,
    textLength: record.textLength,
    ...generateTexture(record),
  },
  imageUrls: record.imageUrls,
  galleryFolder: record.galleryFolder,
  galleryImageUrls: record.galleryImageUrls,
  contentHash: record.contentHash,
  embeddingRef: record.embeddingRef,
  embeddingModel: record.embeddingModel,
  url: record.url,
}));

const manifest = {
  schemaVersion: 4,
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
    clusters: new Set(records.map((record) => record.cluster)).size,
  },
  records,
};

await mkdir(path.dirname(outputPath), { recursive: true });
const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;
await writeFile(outputPath, manifestJson);

const legacyTextureBytes = Buffer.byteLength(JSON.stringify(records.map((record) => ({
  width: record.texture.width,
  height: record.texture.height,
  cells: record.texture.rle.flatMap(([value, count]) => Array.from({ length: count }, () => textureOpacityByValue[value] ?? 0.05)),
}))));
const rleTextureBytes = Buffer.byteLength(JSON.stringify(records.map((record) => ({
  width: record.texture.width,
  height: record.texture.height,
  encoding: record.texture.encoding,
  rle: record.texture.rle,
}))));
const textureReduction = legacyTextureBytes > 0
  ? ((1 - rleTextureBytes / legacyTextureBytes) * 100).toFixed(1)
  : '0.0';

console.log(`archive manifest written: ${path.relative(root, outputPath)} (${records.length} records, ${Buffer.byteLength(manifestJson)} bytes)`);
console.log(`texture encoding rle4: ${legacyTextureBytes} bytes legacy cells -> ${rleTextureBytes} bytes rle4 (${textureReduction}% smaller)`);
await syncSupabase(semanticRecords);
