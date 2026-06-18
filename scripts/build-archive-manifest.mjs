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

function youtubeDirectiveUrl(block) {
  const match = block.trim().match(/^!youtube\s+(https?:\/\/(?:www\.)?(?:youtube\.com|youtu\.be)\/\S+)/i);
  return match?.[1] ?? null;
}

const textureOpacityByValue = [0.05, 0.24, 0.72, 0.85];
const textureLayoutProfile = {
  width: 32,
  height: 24,
  margin: 4,
  paragraphGap: 1,
  youtubeBlockHeight: 4,
};
const textureRenderProfiles = {
  field: {
    role: 'field',
    width: 8,
    height: 8,
    minOpacity: 0.12,
    color: 'currentColor',
    className: 'archive-texture archive-texture--field',
  },
  modal: {
    role: 'modal',
    width: 32,
    height: 24,
    minOpacity: 0.05,
    color: 'currentColor',
    className: 'archive-texture archive-texture--modal',
  },
};
const fieldLayoutProfile = {
  cols: 28,
  rows: 18,
};

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

function extractSemanticBlocks(rawBody) {
  return rawBody
    .split(/\n\s*\n/)
    .map((block, index) => {
      const youtubeUrl = youtubeDirectiveUrl(block);
      if (youtubeUrl) {
        return {
          id: `block-${index}`,
          kind: 'youtube',
          url: youtubeUrl,
        };
      }

      const text = plainText(block);
      if (!text) return null;

      return {
        id: `block-${index}`,
        kind: 'paragraph',
        text,
      };
    })
    .filter(Boolean);
}

function generateTextureLayoutGraph(blocks, profile = textureLayoutProfile) {
  const textWidth = profile.width - profile.margin * 2;
  let cursorY = 0;
  const nodes = [];

  for (const block of blocks) {
    if (cursorY >= profile.height) break;

    if (block.kind === 'youtube') {
      const height = Math.min(profile.youtubeBlockHeight, profile.height - cursorY);
      nodes.push({
        id: `node-${nodes.length}`,
        kind: 'mediaBlock',
        mediaType: 'youtube',
        sourceBlockId: block.id,
        x: profile.margin,
        y: cursorY,
        width: textWidth,
        height,
        frame: true,
        playMarker: true,
      });
      cursorY += height + profile.paragraphGap;
      continue;
    }

    if (block.kind === 'paragraph') {
      const lines = [];
      let remaining = block.text.length;

      while (remaining > 0 && cursorY + lines.length < profile.height) {
        lines.push({ fillWidth: Math.min(textWidth, remaining) });
        remaining -= textWidth;
      }

      if (lines.length > 0) {
        nodes.push({
          id: `node-${nodes.length}`,
          kind: 'textBlock',
          sourceBlockId: block.id,
          x: profile.margin,
          y: cursorY,
          width: textWidth,
          height: lines.length,
          lines,
        });
        cursorY += lines.length + profile.paragraphGap;
      }
    }
  }

  return {
    schemaVersion: 1,
    canvas: {
      width: profile.width,
      height: profile.height,
      unit: 'cell',
    },
    nodes,
  };
}

function createTextureCanvas(width, height) {
  return Array.from({ length: width * height }, () => quantizeTextureOpacity(0.05));
}

function paintTextureCell(canvas, width, height, x, y, opacity) {
  if (x < 0 || x >= width || y < 0 || y >= height) return;
  canvas[y * width + x] = quantizeTextureOpacity(opacity);
}

function rasterizeTextBlock(canvas, graph, node) {
  for (let lineIndex = 0; lineIndex < node.lines.length; lineIndex += 1) {
    const line = node.lines[lineIndex];
    const y = node.y + lineIndex;
    for (let x = node.x; x < node.x + node.width; x += 1) {
      const insideText = x < node.x + line.fillWidth;
      paintTextureCell(canvas, graph.canvas.width, graph.canvas.height, x, y, insideText ? 0.85 : 0.05);
    }
  }
}

function rasterizeMediaBlock(canvas, graph, node) {
  for (let y = node.y; y < node.y + node.height; y += 1) {
    const isHorizontalEdge = y === node.y || y === node.y + node.height - 1;

    for (let x = node.x; x < node.x + node.width; x += 1) {
      const isVerticalEdge = x === node.x || x === node.x + node.width - 1;
      const isPlayMarker = node.playMarker && !isHorizontalEdge && x >= node.x + 11 && x <= node.x + 13;

      if (isHorizontalEdge || isVerticalEdge) {
        paintTextureCell(canvas, graph.canvas.width, graph.canvas.height, x, y, 0.72);
      } else if (isPlayMarker) {
        paintTextureCell(canvas, graph.canvas.width, graph.canvas.height, x, y, 0.85);
      } else {
        paintTextureCell(canvas, graph.canvas.width, graph.canvas.height, x, y, 0.24);
      }
    }
  }
}

const textureRasterizers = {
  textBlock: rasterizeTextBlock,
  mediaBlock: rasterizeMediaBlock,
};

function rasterizeTextureLayoutGraph(graph) {
  const canvas = createTextureCanvas(graph.canvas.width, graph.canvas.height);

  for (const node of graph.nodes) {
    textureRasterizers[node.kind]?.(canvas, graph, node);
  }

  return canvas;
}

function cellOpacity(value) {
  return textureOpacityByValue[value] ?? textureOpacityByValue[0];
}

function downsampleQuantizedTexture(sourceValues, sourceWidth, sourceHeight, targetWidth, targetHeight) {
  const values = [];

  for (let y = 0; y < targetHeight; y += 1) {
    const startY = Math.floor((y * sourceHeight) / targetHeight);
    const endY = Math.max(startY + 1, Math.ceil(((y + 1) * sourceHeight) / targetHeight));

    for (let x = 0; x < targetWidth; x += 1) {
      const startX = Math.floor((x * sourceWidth) / targetWidth);
      const endX = Math.max(startX + 1, Math.ceil(((x + 1) * sourceWidth) / targetWidth));
      let total = 0;
      let count = 0;

      for (let sourceY = startY; sourceY < endY; sourceY += 1) {
        for (let sourceX = startX; sourceX < endX; sourceX += 1) {
          total += cellOpacity(sourceValues[sourceY * sourceWidth + sourceX]);
          count += 1;
        }
      }

      values.push(quantizeTextureOpacity(count > 0 ? total / count : 0.05));
    }
  }

  return values;
}

function generateTextureRenderPayload(sourceValues, sourceWidth, sourceHeight, profile) {
  const values = sourceWidth === profile.width && sourceHeight === profile.height
    ? sourceValues
    : downsampleQuantizedTexture(sourceValues, sourceWidth, sourceHeight, profile.width, profile.height);

  return {
    schemaVersion: 1,
    role: profile.role,
    width: profile.width,
    height: profile.height,
    minOpacity: profile.minOpacity,
    color: profile.color,
    className: profile.className,
    encoding: 'rle4',
    rle: encodeRle4(values),
  };
}

function generateTextureViewModel(record) {
  const semanticBlocks = extractSemanticBlocks(record.rawBody);
  const layoutGraph = generateTextureLayoutGraph(semanticBlocks);
  const rasterValues = rasterizeTextureLayoutGraph(layoutGraph);

  return {
    schemaVersion: 2,
    density: record.score > 0.72 ? 'high' : record.score > 0.38 ? 'medium' : 'low',
    imageCount: record.imageUrls.length + record.galleryImageUrls.length,
    textLength: record.textLength,
    layout: {
      schemaVersion: layoutGraph.schemaVersion,
      nodeCount: layoutGraph.nodes.length,
      canvas: layoutGraph.canvas,
    },
    renders: Object.fromEntries(
      Object.entries(textureRenderProfiles).map(([key, profile]) => [
        key,
        generateTextureRenderPayload(rasterValues, layoutGraph.canvas.width, layoutGraph.canvas.height, profile),
      ])
    ),
  };
}

function nearestOpenSlot(preferred, occupied, profile = fieldLayoutProfile) {
  if (!occupied.has(preferred)) return preferred;
  const totalSlots = profile.cols * profile.rows;
  const preferredCol = preferred % profile.cols;
  const preferredRow = Math.floor(preferred / profile.cols);
  let best = -1;
  let bestDistance = Infinity;

  for (let index = 0; index < totalSlots; index += 1) {
    if (occupied.has(index)) continue;
    const col = index % profile.cols;
    const row = Math.floor(index / profile.cols);
    const distance = Math.abs(col - preferredCol) + Math.abs(row - preferredRow);
    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  }
  return best;
}

function generateFieldViewModel(records, profile = fieldLayoutProfile) {
  const totalSlots = profile.cols * profile.rows;
  const occupied = new Set();
  const latestRecordId = [...records]
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())[0]?.id;
  const fieldRecords = records.map((record) => {
    const preferredCol = Math.max(0, Math.min(profile.cols - 1, Math.floor(record.position.x * profile.cols)));
    const preferredRow = Math.max(0, Math.min(profile.rows - 1, Math.floor(record.position.y * profile.rows)));
    const slot = nearestOpenSlot(preferredRow * profile.cols + preferredCol, occupied, profile);
    occupied.add(slot);

    return {
      id: record.id,
      slot,
      col: slot % profile.cols,
      row: Math.floor(slot / profile.cols),
      isLatest: record.id === latestRecordId,
    };
  });
  const emptyTiles = Array.from({ length: totalSlots }, (_, slot) => ({
    slot,
    col: slot % profile.cols,
    row: Math.floor(slot / profile.cols),
    tone: (slot * 13 + Math.floor(slot / profile.cols) * 7) % 9,
  })).filter((tile) => !occupied.has(tile.slot));

  return {
    schemaVersion: 1,
    cols: profile.cols,
    rows: profile.rows,
    records: fieldRecords,
    emptyTiles,
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
  texture: generateTextureViewModel(record),
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
console.log(`texture encoding rle4: ${legacyTextureBytes} bytes legacy cells -> ${rleTextureBytes} bytes rle4 (${textureReduction}% smaller)`);
await syncSupabase(semanticRecords);
