// Embedding diagnostic report. Read-only: never touches the build pipeline or its outputs.
//
// The archive manifest deliberately excludes raw vectors (manifestPolicy: "render
// snapshot only; raw vectors are excluded") and the generation functions in
// scripts/build-archive-manifest.mjs are module-private with top-level build side
// effects, so this script mirrors that hashing logic instead of importing it.
// The functions below (parseFrontmatter, plainText, tokensFor, hashToken,
// embeddingFor) must stay in sync with build-archive-manifest.mjs; embeddings are
// deterministic, so the re-derived vectors match what the build stored in
// archive_embeddings. Projection axis selection is shared for real via
// src/lib/archive/embeddingProjection.mjs.
//
// Usage: node scripts/analyze-embedding.mjs [--seed <number>]

import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectProjectionAxes } from '../src/lib/archive/embeddingProjection.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const recordsDir = path.join(root, 'src', 'content', 'records');
const embeddingDimensions = 64;
const markdownExtensions = new Set(['.md', '.markdown', '.mdx']);

const seedArgIndex = process.argv.indexOf('--seed');
const seed = seedArgIndex !== -1 ? Number(process.argv[seedArgIndex + 1]) : 42;

// ---------------------------------------------------------------------------
// Mirrored loading logic (see scripts/build-archive-manifest.mjs)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

// Deterministic PRNG so bootstrap runs are reproducible (override with --seed).
function mulberry32(a) {
  return function next() {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sampleWithoutReplacement(items, count, random) {
  const pool = [...items];
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, count);
}

function quantile(sortedValues, q) {
  if (sortedValues.length === 0) return NaN;
  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.round(q * (sortedValues.length - 1))));
  return sortedValues[index];
}

function formatNumber(value, digits = 4) {
  return Number.isFinite(value) ? value.toFixed(digits) : 'n/a';
}

function heading(title) {
  console.log('');
  console.log(`## ${title}`);
  console.log('-'.repeat(60));
}

async function loadRecords() {
  const files = await listMarkdownFiles(recordsDir);
  const records = await Promise.all(files.map(async (file) => {
    const raw = await readFile(file, 'utf8');
    const { data, body } = parseFrontmatter(raw);
    const text = plainText(body);
    const normalizedType = data.type === 'mediaRail' ? 'mediaRail' : 'standard';
    const searchableText = [data.title, data.excerpt, data.location, normalizedType, text].filter(Boolean).join('\n');
    return {
      id: slugFromFile(file),
      title: data.title ?? slugFromFile(file),
      visibility: data.visibility ?? 'public',
      embedding: embeddingFor(searchableText),
    };
  }));
  return records.filter((record) => record.visibility !== 'private');
}

function reportDimensionUsage(records) {
  heading('1. 차원 사용률');
  const n = records.length;
  const nonZeroCounts = Array(embeddingDimensions).fill(0);
  for (const record of records) {
    record.embedding.forEach((value, index) => {
      if (value !== 0) nonZeroCounts[index] += 1;
    });
  }

  const { variance } = selectProjectionAxes(records.map((record) => record.embedding));
  const perDim = nonZeroCounts.map((count, index) => ({
    index,
    nonZeroRatio: count / n,
    variance: variance[index] / n,
  }));

  const activeDims = perDim.filter((dim) => dim.nonZeroRatio >= 0.05);
  console.log(`active dimension (non-zero 비율 5% 이상): ${activeDims.length} / ${embeddingDimensions}`);

  const dead = perDim.filter((dim) => dim.nonZeroRatio === 0).map((dim) => dim.index);
  if (dead.length > 0) console.log(`한 번도 사용되지 않은 차원: [${dead.join(', ')}]`);

  console.log('');
  console.log('variance 상위 10개 차원:');
  console.log('  dim | variance   | non-zero 비율');
  [...perDim]
    .sort((a, b) => b.variance - a.variance)
    .slice(0, 10)
    .forEach((dim) => {
      console.log(`  ${String(dim.index).padStart(3)} | ${formatNumber(dim.variance, 6)} | ${(dim.nonZeroRatio * 100).toFixed(1)}%`);
    });
}

function reportCollisions(records) {
  heading('2. Collision');
  const groups = new Map();
  for (const record of records) {
    const key = record.embedding.join(',');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record.id);
  }

  console.log(`전체 records: ${records.length}`);
  console.log(`unique embedding vector: ${groups.size}`);

  const collisions = [...groups.values()].filter((ids) => ids.length > 1);
  if (collisions.length === 0) {
    console.log('완전히 동일한 vector를 가진 record 그룹: 없음');
  } else {
    console.log(`완전히 동일한 vector를 가진 record 그룹 ${collisions.length}개:`);
    collisions.forEach((ids, index) => console.log(`  그룹 ${index + 1}: ${ids.join(', ')}`));
  }
}

function reportCosineDistribution(records) {
  heading('3. Cosine 유사도 분포');
  const pairs = [];
  for (let i = 0; i < records.length; i += 1) {
    for (let j = i + 1; j < records.length; j += 1) {
      pairs.push({
        a: records[i],
        b: records[j],
        similarity: cosineSimilarity(records[i].embedding, records[j].embedding),
      });
    }
  }

  if (pairs.length === 0) {
    console.log('record 쌍이 없습니다 (records < 2).');
    return;
  }

  const sorted = pairs.map((pair) => pair.similarity).sort((a, b) => a - b);
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  console.log(`전체 pair 수: ${pairs.length}`);
  console.log(`평균:     ${formatNumber(mean)}`);
  console.log(`중앙값:   ${formatNumber(quantile(sorted, 0.5))}`);
  console.log(`상위 5%:  ${formatNumber(quantile(sorted, 0.95))}`);
  console.log(`최댓값:   ${formatNumber(sorted[sorted.length - 1])}`);

  console.log('');
  console.log('가장 유사한 상위 5개 pair:');
  [...pairs]
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, 5)
    .forEach((pair, index) => {
      console.log(`  ${index + 1}. ${formatNumber(pair.similarity)} | "${pair.a.title}" (${pair.a.id}) ↔ "${pair.b.title}" (${pair.b.id})`);
    });
}

function reportAxisStability(records, random, persisted) {
  heading('4. 축 안정성 (bootstrap)');
  const embeddings = records.map((record) => record.embedding);
  const full = selectProjectionAxes(embeddings);
  console.log(`전체 데이터 기준 축: xAxis = dim ${full.xAxis}, yAxis = dim ${full.yAxis}`);
  if (persisted) {
    const drifted = persisted.xAxis !== full.xAxis || persisted.yAxis !== full.yAxis;
    console.log(`manifest에 고정된 축: xAxis = dim ${persisted.xAxis}, yAxis = dim ${persisted.yAxis} (created ${persisted.createdAt ?? 'n/a'})`);
    if (drifted) console.log('참고: 재계산 축이 고정 축과 다름 — 빌드는 고정 축을 계속 사용하며, 갱신은 --recalculate-projection으로만 발생');
  } else {
    console.log('manifest에 고정된 축 없음 (다음 빌드에서 위 축이 저장됨)');
  }
  console.log(`(seed ${seed}, 각 비율당 20회 재추출)`);

  for (const ratio of [0.5, 0.8]) {
    const iterations = 20;
    const sampleSize = Math.max(2, Math.round(embeddings.length * ratio));
    let xMatches = 0;
    let yMatches = 0;
    let setMatches = 0;
    const xFrequency = new Map();
    const yFrequency = new Map();

    for (let run = 0; run < iterations; run += 1) {
      const sample = sampleWithoutReplacement(embeddings, sampleSize, random);
      const axes = selectProjectionAxes(sample);
      if (axes.xAxis === full.xAxis) xMatches += 1;
      if (axes.yAxis === full.yAxis) yMatches += 1;
      const sameSet = new Set([axes.xAxis, axes.yAxis, full.xAxis, full.yAxis]).size === 2;
      if (sameSet) setMatches += 1;
      xFrequency.set(axes.xAxis, (xFrequency.get(axes.xAxis) ?? 0) + 1);
      yFrequency.set(axes.yAxis, (yFrequency.get(axes.yAxis) ?? 0) + 1);
    }

    const percent = (count) => `${((count / iterations) * 100).toFixed(0)}%`;
    console.log('');
    console.log(`${Math.round(ratio * 100)}% 샘플 (${sampleSize}개, ${iterations}회):`);
    console.log(`  xAxis 일치율 ${percent(xMatches)}, yAxis 일치율 ${percent(yMatches)}, 축 집합(순서 무시) 일치율 ${percent(setMatches)}`);

    const unstable = xMatches < iterations * 0.8 || yMatches < iterations * 0.8;
    if (unstable) {
      const table = (frequency) => [...frequency.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([dim, count]) => `dim ${dim}×${count}`)
        .join(', ');
      console.log(`  선택된 xAxis 빈도: ${table(xFrequency)}`);
      console.log(`  선택된 yAxis 빈도: ${table(yFrequency)}`);
    }
  }
}

const records = await loadRecords();
console.log('# Embedding 진단 리포트');
console.log(`source: src/content/records (${records.length} public records, ` +
  'build-archive-manifest.mjs와 동일한 해싱 로직으로 재유도 — manifest는 정책상 원본 벡터를 저장하지 않음)');

if (records.length === 0) {
  console.log('분석할 record가 없습니다.');
  process.exit(0);
}

reportDimensionUsage(records);
reportCollisions(records);
reportCosineDistribution(records);
const persistedProjection = await readFile(path.join(root, 'public', 'archive-manifest.json'), 'utf8')
  .then((raw) => JSON.parse(raw)?.embeddingProjection ?? null)
  .catch(() => null);
reportAxisStability(records, mulberry32(seed), persistedProjection);
