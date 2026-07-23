import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import archiveManifest from '../public/archive-manifest.json' with { type: 'json' };

import { deriveFieldTraces, generateFieldViewModel, mergeFieldTraces } from '../src/lib/archive/fieldViewModel.mjs';
import { renderTextureSet, renderTextureSvg } from '../src/lib/archiveTexture.ts';
import { createArchiveIndexView } from '../src/lib/archive/pageViewModel.mjs';
import {
  downsampleQuantizedTexture,
  remapToneForPolicy,
  extractSemanticBlocks,
  generateTextureLayoutGraph,
  generateTextureRenderPayload,
  generateTextureViewModel,
  quantizeTextureOpacity,
  rasterizeTextureLayoutGraph,
  normalizedRuntimeScore,
  runtimeLodForNormalizedScore,
  textureLodPolicies,
  textureLodRenderResolutions,
  textureRenderProfiles,
} from '../src/lib/archive/texturePipeline.mjs';
import {
  decodeTextureRenderPayload,
  isTextureRenderPayload,
  textureMaxCellValue,
  textureOpacityByValue,
  textureRenderPayloadSchemaVersion,
} from '../src/lib/archive/textureRenderContract.mjs';

import {
  calculateRegionStats,
  createRectFootprintAroundSeed,
  footprintArea,
  incrementalRegionLayout,
  isSlotInFootprint,
  maintainRegionFootprint,
  nearestOpenSlotInFootprint,
  regionDensityPolicy,
  regionIdForTag,
  repairFootprintOverlaps,
  slotsInFootprint,
} from '../src/lib/archive/regionLayout.mjs';

const plainText = (body) => body
  .replace(/<[^>]+>/g, ' ')
  .replace(/!\[[^\]]*\]\([^)]+\)/g, ' ')
  .replace(/[`*_>#\-[\]()]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

test('extractSemanticBlocks separates paragraphs and youtube directives', () => {
  const blocks = extractSemanticBlocks('hello archive\n\n!youtube https://youtu.be/example\n\n**final** note', plainText);

  assert.deepEqual(blocks.map((block) => block.kind), ['paragraph', 'youtube', 'paragraph']);
  assert.equal(blocks[1].url, 'https://youtu.be/example');
});

test('texture layout graph uses block nodes rather than row records', () => {
  const blocks = extractSemanticBlocks('abcdefghijklmnopqrstuvwxy\n\n!youtube https://youtube.com/watch?v=abc', plainText);
  const graph = generateTextureLayoutGraph(blocks);

  assert.equal(graph.schemaVersion, 1);
  assert.deepEqual(graph.canvas, { width: 64, height: 48, unit: 'cell' });
  assert.deepEqual(graph.nodes.map((node) => node.kind), ['textBlock', 'mediaBlock']);
  assert.equal(graph.nodes[0].lines.length, 1);
});

test('render payload validates against the runtime schema contract', () => {
  const graph = generateTextureLayoutGraph(extractSemanticBlocks('short paragraph', plainText));
  const raster = rasterizeTextureLayoutGraph(graph);
  const payload = generateTextureRenderPayload(raster, graph.canvas.width, graph.canvas.height, textureRenderProfiles.field);

  assert.equal(isTextureRenderPayload(payload), true);
  assert.equal(payload.lod, 0);
  assert.equal(payload.width, 12);
  assert.equal(payload.height, 9);
  assert.equal(decodeTextureRenderPayload(payload).length, 108);
});

test('texture cells quantize opacity into four tone levels', () => {
  assert.equal(textureOpacityByValue.length, textureMaxCellValue + 1);
  assert.equal(quantizeTextureOpacity(0), 0);
  assert.equal(quantizeTextureOpacity(0.2), 1);
  assert.equal(quantizeTextureOpacity(0.5), 2);
  assert.equal(quantizeTextureOpacity(0.9), 3);
  assert.equal(quantizeTextureOpacity(1.4), 3);
  assert.equal(quantizeTextureOpacity(Number.NaN), 0);
});

test('field downsampling keeps mid tones instead of flattening to a binary mask', () => {
  const ink = textureMaxCellValue;
  const source = [
    ink, ink, ink, ink,
    ink, ink, ink, 0,
  ];
  const values = downsampleQuantizedTexture(source, 4, 2, 2, 1, textureLodPolicies[2]);

  assert.equal(values[0], 3);
  assert.equal(values[1], 2);
});

test('LOD policies restrict the tone palette so fidelity reads at tile scale', () => {
  assert.deepEqual(textureLodPolicies[0].allowedTones, [2]);
  assert.deepEqual(textureLodPolicies[1].allowedTones, [1, 3]);
  assert.deepEqual(textureLodPolicies[2].allowedTones, [1, 2, 3]);

  // nearest allowed tone, ties resolve darker, paper (0) passes through
  assert.equal(remapToneForPolicy(3, textureLodPolicies[0]), 2);
  assert.equal(remapToneForPolicy(1, textureLodPolicies[0]), 2);
  assert.equal(remapToneForPolicy(2, textureLodPolicies[1]), 3);
  assert.equal(remapToneForPolicy(1, textureLodPolicies[1]), 1);
  assert.equal(remapToneForPolicy(2, textureLodPolicies[2]), 2);
  assert.equal(remapToneForPolicy(0, textureLodPolicies[0]), 0);

  const ink = textureMaxCellValue;
  const source = [
    ink, ink, ink, ink,
    ink, ink, ink, 0,
  ];
  const flat = downsampleQuantizedTexture(source, 4, 2, 2, 1, textureLodPolicies[0]);
  const split = downsampleQuantizedTexture(source, 4, 2, 2, 1, textureLodPolicies[1]);

  assert.deepEqual([...new Set(flat.filter((value) => value > 0))], [2]);
  assert.ok(split.filter((value) => value > 0).every((value) => value === 1 || value === 3));
});

test('contract rejects tone levels outside the palette and legacy payload versions', () => {
  const base = {
    schemaVersion: textureRenderPayloadSchemaVersion,
    role: 'field',
    lod: 0,
    width: 2,
    height: 1,
    color: 'currentColor',
    className: 'archive-texture archive-texture--field',
    encoding: 'rle4',
    rle: [[3, 1], [1, 1]],
  };

  assert.equal(isTextureRenderPayload(base), true);
  assert.equal(isTextureRenderPayload({ ...base, rle: [[4, 2]] }), false);
  assert.equal(isTextureRenderPayload({ ...base, schemaVersion: 1 }), false);
  assert.deepEqual(decodeTextureRenderPayload(base), [3, 1]);
});

test('svg renderer maps tone levels to opacity and merges horizontal runs', () => {
  const payload = {
    schemaVersion: textureRenderPayloadSchemaVersion,
    role: 'field',
    lod: 0,
    width: 3,
    height: 2,
    color: 'currentColor',
    className: 'archive-texture archive-texture--field',
    encoding: 'rle4',
    rle: [[3, 2], [1, 2], [0, 2]],
  };

  const svg = renderTextureSvg(payload);
  const rects = svg.match(/<rect/g) ?? [];

  assert.equal(rects.length, 3);
  assert.match(svg, /width="2"[\s\S]*?opacity="0\.720"/);
  assert.match(svg, /opacity="0\.252"/);
});

test('runtime score selects an LOD policy after rebuild-local log normalization', () => {
  assert.equal(runtimeLodForNormalizedScore(0.2), 0);
  assert.equal(runtimeLodForNormalizedScore(0.5), 1);
  assert.equal(runtimeLodForNormalizedScore(0.9), 2);
  assert.equal(normalizedRuntimeScore({ runtimeScore: 9 }, Math.log1p(9)), 1);
  assert.equal(textureLodPolicies[0].coverageThreshold, 0.6);
  assert.equal(textureLodPolicies[1].coverageThreshold, 0.45);
  assert.equal(textureLodPolicies[2].coverageThreshold, 0.3);
  assert.equal(textureLodPolicies[2].preserveThinLines, true);
  assert.deepEqual(textureLodRenderResolutions[0], { width: 12, height: 9 });
  assert.deepEqual(textureLodRenderResolutions[1], { width: 24, height: 18 });
  assert.deepEqual(textureLodRenderResolutions[2], { width: 40, height: 30 });
});

test('runtime LOD is applied only to field render payloads', () => {
  const view = generateTextureViewModel({
    rawBody: 'semantic density should simplify field only',
    type: 'standard',
    score: 0.1,
    runtimeScore: 9,
    imageUrls: [],
    galleryImageUrls: [],
    textLength: 43,
  }, plainText, { runtimeLodScale: Math.log1p(9) });

  assert.equal(view.texture.renders.field.lod, 2);
  assert.equal(view.texture.density, 'low');
  assert.equal(view.texture.renders.field.width, 40);
  assert.equal(view.texture.renders.field.height, 30);
  assert.equal(view.texture.renders.modal.lod, 1);
  assert.equal(view.texture.renders.modal.width, 64);
  assert.equal(view.texture.renders.modal.height, 48);
  assert.deepEqual(
    decodeTextureRenderPayload(view.texture.renders.modal),
    rasterizeTextureLayoutGraph(view.debug.layoutGraph)
  );
});


test('semantic score alone does not raise texture LOD', () => {
  const view = generateTextureViewModel({
    rawBody: 'semantic density can be high while runtime texture stays quiet',
    type: 'standard',
    score: 0.95,
    runtimeScore: 0,
    imageUrls: [],
    galleryImageUrls: [],
    textLength: 61,
  }, plainText, { runtimeLodScale: Math.log1p(10) });

  assert.equal(view.texture.density, 'high');
  assert.equal(view.texture.renders.field.lod, 0);
  assert.equal(view.texture.renders.field.width, 12);
  assert.equal(view.texture.renders.field.height, 9);
});


test('field runtime LOD changes render resolution while source raster and modal stay fixed', () => {
  const cases = [
    { runtimeScore: 0, runtimeLodScale: Math.log1p(9), lod: 0, width: 12, height: 9 },
    { runtimeScore: 3, runtimeLodScale: Math.log1p(9), lod: 1, width: 24, height: 18 },
    { runtimeScore: 9, runtimeLodScale: Math.log1p(9), lod: 2, width: 40, height: 30 },
  ];

  for (const expected of cases) {
    const view = generateTextureViewModel({
      rawBody: 'runtime layer controls field render resolution without changing semantic layout',
      type: 'standard',
      score: 0.1,
      runtimeScore: expected.runtimeScore,
      imageUrls: [],
      galleryImageUrls: [],
      textLength: 72,
    }, plainText, { runtimeLodScale: expected.runtimeLodScale });

    assert.deepEqual(view.debug.layoutGraph.canvas, { width: 64, height: 48, unit: 'cell' });
    assert.equal(view.texture.renders.field.lod, expected.lod);
    assert.equal(view.texture.renders.field.width, expected.width);
    assert.equal(view.texture.renders.field.height, expected.height);
    assert.equal(decodeTextureRenderPayload(view.texture.renders.field).length, expected.width * expected.height);
    assert.equal(view.texture.renders.modal.width, 64);
    assert.equal(view.texture.renders.modal.height, 48);
    assert.deepEqual(
      decodeTextureRenderPayload(view.texture.renders.modal),
      rasterizeTextureLayoutGraph(view.debug.layoutGraph)
    );
  }
});

test('field view model stores structural record slots only', () => {
  const view = generateFieldViewModel([
    { id: 'old', date: '2024-01-01', position: { x: 0.1, y: 0.1 } },
    { id: 'new', date: '2025-01-01', position: { x: 0.1, y: 0.1 } },
  ], { cols: 2, rows: 2 });

  assert.equal(view.schemaVersion, 1);
  assert.equal(view.records.length, 2);
  assert.equal('emptyTiles' in view, false);
  assert.equal(view.records.find((record) => record.id === 'new').isLatest, true);
  assert.notEqual(view.records[0].slot, view.records[1].slot);
});

test('field traces mark vacated cells from moves, displacements, and removals — even covered ones', () => {
  const profile = { cols: 4, rows: 4 };
  const events = [
    { eventType: 'layout.moved_within_region', recordId: 'a', fromSlot: 5, toSlot: 9 },
    { eventType: 'layout.displaced', recordId: 'b', fromSlot: 6, toSlot: 10 },
    { eventType: 'record.removed', recordId: 'gone', fromSlot: 11, toSlot: null },
    { eventType: 'layout.moved_within_region', recordId: 'c', fromSlot: 2, toSlot: 2 },
    { eventType: 'layout.slot_preserved', recordId: 'd', fromSlot: 12, toSlot: 12 },
    { eventType: 'record.first_seen', recordId: 'e', fromSlot: null, toSlot: null },
  ];

  const traces = deriveFieldTraces(events, profile);

  assert.deepEqual(traces, [
    { slot: 5, col: 1, row: 1, recordId: 'a', kind: 'moved' },
    { slot: 6, col: 2, row: 1, recordId: 'b', kind: 'displaced' },
    { slot: 11, col: 3, row: 2, recordId: 'gone', kind: 'removed' },
  ]);
});

test('traces accumulate across rebuilds and refresh instead of duplicating', () => {
  const previous = [
    { slot: 5, col: 1, row: 1, recordId: 'a', kind: 'moved', rebuildId: 'r1' },
    { slot: 6, col: 2, row: 1, recordId: 'b', kind: 'moved', rebuildId: 'r1' },
  ];
  const fresh = [
    { slot: 5, col: 1, row: 1, recordId: 'a', kind: 'moved', rebuildId: 'r2' },
    { slot: 9, col: 1, row: 2, recordId: 'c', kind: 'removed', rebuildId: 'r2' },
  ];

  const merged = mergeFieldTraces(previous, fresh);

  assert.equal(merged.length, 3);
  assert.deepEqual(merged.map((trace) => `${trace.slot}:${trace.recordId}`), ['6:b', '5:a', '9:c']);
  assert.equal(merged.find((trace) => trace.recordId === 'a').rebuildId, 'r2');
});

test('field view model embeds precomposed traces verbatim', () => {
  const records = [
    { id: 'moved', date: '2025-01-01', position: { x: 0.1, y: 0.1 }, layoutSlot: 4, regionId: 'tag:x' },
  ];
  const traces = deriveFieldTraces([
    { eventType: 'layout.moved_within_region', recordId: 'moved', fromSlot: 3, toSlot: 4 },
  ], { cols: 40, rows: 25 });

  const view = generateFieldViewModel(records, { cols: 40, rows: 25 }, [], traces);

  assert.equal(view.traces.length, 1);
  assert.equal(view.traces[0].recordId, 'moved');
  assert.equal(view.traces[0].slot, 3);
  assert.equal(view.traces[0].kind, 'moved');
});

test('archive manifest exposes a field traces array', () => {
  assert.ok(Array.isArray(archiveManifest.archiveView.field.traces));
  for (const trace of archiveManifest.archiveView.field.traces) {
    assert.equal(typeof trace.recordId, 'string');
    assert.equal(Number.isInteger(trace.slot), true);
    assert.equal(Number.isInteger(trace.col), true);
    assert.equal(Number.isInteger(trace.row), true);
  }
});

test('UI texture set renderer only accepts rle render payloads', () => {
  const graph = generateTextureLayoutGraph(extractSemanticBlocks('short paragraph', plainText));
  const raster = rasterizeTextureLayoutGraph(graph);
  const renders = {
    field: generateTextureRenderPayload(raster, graph.canvas.width, graph.canvas.height, textureRenderProfiles.field),
    modal: generateTextureRenderPayload(raster, graph.canvas.width, graph.canvas.height, textureRenderProfiles.modal),
  };

  const textureSvg = renderTextureSet(renders);

  assert.match(textureSvg.field, /archive-texture--field/);
  assert.match(textureSvg.modal, /archive-texture--modal/);
  assert.equal('cells' in renders.field, false);
});

test('archive manifest stores texture as rle render payloads, not svg strings or legacy cells', () => {
  for (const record of archiveManifest.records) {
    assert.equal(record.texture.schemaVersion, 2);
    assert.equal(typeof record.texture, 'object');
    assert.equal(typeof record.texture.renders.field, 'object');
    assert.equal(record.texture.renders.field.encoding, 'rle4');
    assert.equal(record.texture.renders.modal.encoding, 'rle4');
    assert.deepEqual(
      { width: record.texture.renders.field.width, height: record.texture.renders.field.height },
      textureLodRenderResolutions[record.texture.renders.field.lod]
    );
    assert.equal(record.texture.renders.modal.width, 64);
    assert.equal(record.texture.renders.modal.height, 48);
    assert.equal('cells' in record.texture.renders.field, false);
    assert.equal('svg' in record.texture.renders.field, false);
  }
});

test('archive page view model pre-renders modal svg and strips raw texture from client records', () => {
  const view = createArchiveIndexView(archiveManifest);

  assert.equal(view.fieldRecords.length, archiveManifest.archiveView.field.records.length);
  assert.match(view.fieldRecords[0].textureSvg.field, /archive-texture--field/);
  assert.match(view.fieldRecords[0].textureSvg.modal, /archive-texture--modal/);

  for (const clientRecord of view.clientRecords) {
    assert.equal('texture' in clientRecord, false);
    assert.equal('renders' in clientRecord, false);
    assert.match(clientRecord.textureSvg.modal, /archive-texture--modal/);
  }
});

test('modal click path clears previous DOM before inserting selected record texture markup', () => {
  const pageSource = readFileSync(new URL('../src/pages/index.astro', import.meta.url), 'utf8');

  assert.match(pageSource, /function selectRecord\(record\)/);
  assert.match(pageSource, /texture\.replaceChildren\(\);/);
  assert.match(pageSource, /texture\.insertAdjacentHTML\('afterbegin', textureMarkup\(record\)\);/);
});

test('Region footprint helpers keep rectangle details behind the footprint API', () => {
  const profile = { cols: 4, rows: 4 };
  const footprint = createRectFootprintAroundSeed(5, 4, profile);

  assert.deepEqual(slotsInFootprint(footprint, profile).sort((a, b) => a - b), [0, 1, 4, 5]);
  assert.equal(isSlotInFootprint(5, footprint, profile), true);
  assert.equal(isSlotInFootprint(15, footprint, profile), false);
  assert.equal(nearestOpenSlotInFootprint(5, new Set([5]), footprint, profile), 1);
});

test('Region incremental layout persists seeds and places new records inside their tag footprint', () => {
  const profile = { cols: 6, rows: 4 };
  const records = [
    { id: 'old-a', tags: ['walk'], date: '2026-01-01', embedding: [1, 0] },
    { id: 'new-a', tags: ['walk'], date: '2026-01-02', embedding: [0.9, 0.1] },
    { id: 'old-b', tags: ['make'], date: '2026-01-01', embedding: [0, 1] },
  ];
  const previousManifest = {
    archiveView: {
      field: {
        regions: [
          {
            id: regionIdForTag('walk'),
            tag: 'walk',
            seedSlot: 7,
            footprint: { schemaVersion: 1, kind: 'rect', rect: { minCol: 0, maxCol: 2, minRow: 0, maxRow: 2 } },
          },
          {
            id: regionIdForTag('make'),
            tag: 'make',
            seedSlot: 22,
            footprint: { schemaVersion: 1, kind: 'rect', rect: { minCol: 4, maxCol: 5, minRow: 2, maxRow: 3 } },
          },
        ],
        records: [
          { id: 'old-a', slot: 7 },
          { id: 'old-b', slot: 22 },
        ],
      },
    },
    records: [],
  };

  const layout = incrementalRegionLayout(records, previousManifest, () => new Map(), profile);
  const oldA = layout.records.find((record) => record.id === 'old-a');
  const newA = layout.records.find((record) => record.id === 'new-a');
  const walkRegion = layout.regions.find((region) => region.id === regionIdForTag('walk'));

  assert.equal(walkRegion.seedSlot, 7);
  assert.equal(oldA.layoutSlot, 7);
  assert.equal(newA.regionId, regionIdForTag('walk'));
  assert.equal(isSlotInFootprint(newA.layoutSlot, walkRegion.footprint, profile), true);
  assert.ok(layout.layoutEvents.some((event) =>
    event.eventType === 'layout.slot_preserved' &&
    event.recordId === 'old-a' &&
    event.fromSlot === 7 &&
    event.toSlot === 7
  ));
  assert.ok(layout.layoutEvents.some((event) =>
    event.eventType === 'layout.anchor_record' &&
    event.recordId === 'new-a' &&
    event.anchorId === 'old-a'
  ));
});


test('Region reseed mode ignores previous record slots for one-time tag migration', () => {
  const profile = { cols: 6, rows: 4 };
  const records = [
    { id: 'old-a', tags: ['walk'], date: '2026-01-01', embedding: [1, 0] },
    { id: 'old-b', tags: ['walk'], date: '2026-01-02', embedding: [0.9, 0.1] },
  ];
  const previousManifest = {
    archiveView: {
      field: {
        regions: [
          {
            id: regionIdForTag('walk'),
            tag: 'walk',
            seedSlot: 23,
            footprint: { schemaVersion: 1, kind: 'cells', cells: [0, 23] },
          },
        ],
        records: [
          { id: 'old-a', slot: 0 },
          { id: 'old-b', slot: 23 },
        ],
      },
    },
    records: [],
  };
  const projected = new Map([[regionIdForTag('walk'), { x: 0.5, y: 0.5 }]]);

  const layout = incrementalRegionLayout(records, previousManifest, () => projected, profile, { regionReseed: true });
  const slots = layout.records.map((record) => record.layoutSlot);

  assert.deepEqual(slots, [15, 9]);
  assert.notDeepEqual(slots, [0, 23]);
});

test('Region stats calculate density from footprint slots', () => {
  const profile = { cols: 4, rows: 4 };
  const region = {
    id: regionIdForTag('walk'),
    footprint: { schemaVersion: 1, kind: 'cells', cells: [0, 1, 4, 5] },
  };
  const stats = calculateRegionStats(region, [
    { id: 'a', regionId: region.id, layoutSlot: 0 },
    { id: 'b', regionId: region.id, layoutSlot: 5 },
    { id: 'c', regionId: 'tag:other', layoutSlot: 1 },
  ], profile);

  assert.deepEqual(stats, {
    occupiedSlots: 2,
    availableSlots: 2,
    density: 0.5,
    targetDensity: 0.72,
  });
});


test('Sleep Rebuild can shrink sparse Region footprints without moving the seed', () => {
  const profile = { cols: 6, rows: 6 };
  const records = [
    { id: 'old-a', tags: ['walk'], date: '2026-01-01', embedding: [1, 0] },
  ];
  const previousManifest = {
    archiveView: {
      field: {
        regions: [
          {
            id: regionIdForTag('walk'),
            tag: 'walk',
            seedSlot: 7,
            footprint: { schemaVersion: 1, kind: 'rect', rect: { minCol: 0, maxCol: 5, minRow: 0, maxRow: 5 } },
          },
        ],
        records: [{ id: 'old-a', slot: 7 }],
      },
    },
    records: [],
  };

  const layout = incrementalRegionLayout(records, previousManifest, () => new Map(), profile, { sleepRebuild: true });
  const region = layout.regions[0];

  assert.equal(region.seedSlot, 7);
  assert.deepEqual(region.footprint.rect, { minCol: 0, maxCol: 2, minRow: 0, maxRow: 2 });
});

test('Sleep Rebuild expands only directions that do not cross neighboring Regions', () => {
  const profile = { cols: 7, rows: 5 };
  const crowded = {
    id: regionIdForTag('crowded'),
    seedSlot: 9,
    footprint: { schemaVersion: 1, kind: 'rect', rect: { minCol: 2, maxCol: 2, minRow: 1, maxRow: 1 } },
  };
  const neighbor = {
    id: regionIdForTag('neighbor'),
    seedSlot: 17,
    footprint: { schemaVersion: 1, kind: 'rect', rect: { minCol: 3, maxCol: 3, minRow: 2, maxRow: 2 } },
  };
  const records = [
    { id: 'a', regionId: crowded.id, layoutSlot: 9 },
    { id: 'b', regionId: neighbor.id, layoutSlot: 17 },
  ];

  const footprint = maintainRegionFootprint(
    crowded,
    records,
    profile,
    { ...regionDensityPolicy, expandAbove: 0.5 },
    [crowded, neighbor]
  );

  assert.deepEqual(footprint.rect, { minCol: 1, maxCol: 3, minRow: 0, maxRow: 1 });
});

test('Sleep Rebuild expansion leaves non-rect footprints unchanged', () => {
  const profile = { cols: 4, rows: 4 };
  const region = {
    id: regionIdForTag('cells'),
    seedSlot: 0,
    footprint: { schemaVersion: 1, kind: 'cells', cells: [0] },
  };

  const footprint = maintainRegionFootprint(
    region,
    [{ id: 'a', regionId: region.id, layoutSlot: 0 }],
    profile,
    { ...regionDensityPolicy, expandAbove: 0.5 },
    [region]
  );

  assert.deepEqual(footprint, region.footprint);
});

test('carried-over footprint overlaps are repaired before placement', () => {
  // mirrors the production overlap: the yielder's rect grew over the keeper's
  // top row, and the keeper holds a record on one of the contested cells
  const profile = { cols: 40, rows: 25 };
  const previousManifest = {
    archiveView: {
      field: {
        regions: [
          {
            id: regionIdForTag('keeper'),
            tag: 'keeper',
            seedSlot: 977,
            footprint: { schemaVersion: 1, kind: 'rect', rect: { minCol: 16, maxCol: 17, minRow: 23, maxRow: 24 } },
          },
          {
            id: regionIdForTag('yielder'),
            tag: 'yielder',
            seedSlot: 898,
            footprint: { schemaVersion: 1, kind: 'rect', rect: { minCol: 16, maxCol: 19, minRow: 19, maxRow: 23 } },
          },
        ],
        records: [
          { id: 'old-a', slot: 937 },
          { id: 'old-b', slot: 898 },
        ],
      },
    },
    records: [],
  };
  const records = [
    { id: 'old-a', tags: ['keeper'], date: '2026-01-01', embedding: [1, 0] },
    { id: 'old-b', tags: ['yielder'], date: '2026-01-02', embedding: [0, 1] },
  ];

  const layout = incrementalRegionLayout(records, previousManifest, () => new Map(), profile);
  const keeper = layout.regions.find((region) => region.id === regionIdForTag('keeper'));
  const yielder = layout.regions.find((region) => region.id === regionIdForTag('yielder'));

  assert.deepEqual(keeper.footprint.rect, { minCol: 16, maxCol: 17, minRow: 23, maxRow: 24 });
  assert.equal(yielder.footprint.kind, 'rect');
  assert.deepEqual(yielder.footprint.rect, { minCol: 16, maxCol: 19, minRow: 19, maxRow: 22 });
  assert.equal(layout.records.find((record) => record.id === 'old-a').layoutSlot, 937);
  assert.equal(layout.records.find((record) => record.id === 'old-b').layoutSlot, 898);
  assert.ok(layout.layoutEvents.some((event) =>
    event.eventType === 'region.footprint_overlap_repaired' &&
    event.regionId === regionIdForTag('yielder') &&
    event.metadata.keeperRegionId === regionIdForTag('keeper') &&
    event.metadata.footprintKindAfter === 'rect'
  ));
});

test('unoccupied contested cells go to the older Region', () => {
  const profile = { cols: 40, rows: 25 };
  const older = {
    id: regionIdForTag('older'),
    tag: 'older',
    seedSlot: 800,
    footprint: { schemaVersion: 1, kind: 'rect', rect: { minCol: 0, maxCol: 1, minRow: 19, maxRow: 21 } },
  };
  const younger = {
    id: regionIdForTag('younger'),
    tag: 'younger',
    seedSlot: 720,
    footprint: { schemaVersion: 1, kind: 'rect', rect: { minCol: 0, maxCol: 1, minRow: 17, maxRow: 19 } },
  };

  const { regions, events } = repairFootprintOverlaps([older, younger], [
    { regionId: older.id, slot: 800 },
    { regionId: younger.id, slot: 720 },
  ], profile);

  assert.deepEqual(regions[0].footprint.rect, older.footprint.rect);
  assert.deepEqual(regions[1].footprint.rect, { minCol: 0, maxCol: 1, minRow: 17, maxRow: 18 });
  assert.equal(events.length, 1);
  assert.equal(events[0].regionId, younger.id);
});

test('a Region whose seed sits on the contested cells keeps them regardless of age', () => {
  const profile = { cols: 4, rows: 4 };
  const older = {
    id: regionIdForTag('older'),
    tag: 'older',
    seedSlot: 5,
    footprint: { schemaVersion: 1, kind: 'rect', rect: { minCol: 1, maxCol: 2, minRow: 1, maxRow: 2 } },
  };
  const younger = {
    id: regionIdForTag('younger'),
    tag: 'younger',
    seedSlot: 6,
    footprint: { schemaVersion: 1, kind: 'cells', cells: [6, 7, 11] },
  };

  const { regions } = repairFootprintOverlaps([older, younger], [], profile);

  assert.deepEqual(regions[1].footprint.cells, [6, 7, 11]);
  assert.deepEqual(regions[0].footprint.rect, { minCol: 1, maxCol: 1, minRow: 1, maxRow: 2 });
});

test('a more central newcomer claims the seed-side cell and displaces the occupant outward', () => {
  const profile = { cols: 6, rows: 4 };
  const records = [
    { id: 'old-a', tags: ['walk'], date: '2026-01-01', embedding: [0, 1] },
    { id: 'old-b', tags: ['walk'], date: '2026-01-02', embedding: [1, 0.2] },
    { id: 'new-core', tags: ['walk'], date: '2026-01-03', embedding: [1, 0] },
  ];
  const previousManifest = {
    archiveView: {
      field: {
        regions: [
          {
            id: regionIdForTag('walk'),
            tag: 'walk',
            seedSlot: 7,
            footprint: { schemaVersion: 1, kind: 'rect', rect: { minCol: 0, maxCol: 2, minRow: 0, maxRow: 2 } },
          },
        ],
        records: [{ id: 'old-a', slot: 7 }, { id: 'old-b', slot: 8 }],
      },
    },
    records: [],
  };

  const layout = incrementalRegionLayout(records, previousManifest, () => new Map(), profile);
  const newcomer = layout.records.find((record) => record.id === 'new-core');
  const displaced = layout.records.find((record) => record.id === 'old-a');

  assert.equal(newcomer.layoutSlot, 7);
  assert.equal(displaced.layoutSlot, 1);
  assert.equal(layout.records.find((record) => record.id === 'old-b').layoutSlot, 8);
  assert.ok(layout.layoutEvents.some((event) =>
    event.eventType === 'layout.displaced' &&
    event.recordId === 'old-a' &&
    event.fromSlot === 7 &&
    event.toSlot === 1 &&
    event.anchorId === 'new-core' &&
    event.anchorKind === 'inserted_record'
  ));
  assert.ok(layout.layoutEvents.some((event) =>
    event.eventType === 'layout.placed' &&
    event.recordId === 'new-core' &&
    event.metadata.displacedRecordId === 'old-a'
  ));
});

test('a less central newcomer takes the nearest open cell without displacing anyone', () => {
  const profile = { cols: 6, rows: 4 };
  const records = [
    { id: 'old-a', tags: ['walk'], date: '2026-01-01', embedding: [1, 0] },
    { id: 'old-b', tags: ['walk'], date: '2026-01-02', embedding: [1, 0.1] },
    { id: 'new-edge', tags: ['walk'], date: '2026-01-03', embedding: [0, 1] },
  ];
  const previousManifest = {
    archiveView: {
      field: {
        regions: [
          {
            id: regionIdForTag('walk'),
            tag: 'walk',
            seedSlot: 7,
            footprint: { schemaVersion: 1, kind: 'rect', rect: { minCol: 0, maxCol: 2, minRow: 0, maxRow: 2 } },
          },
        ],
        records: [{ id: 'old-a', slot: 7 }, { id: 'old-b', slot: 8 }],
      },
    },
    records: [],
  };

  const layout = incrementalRegionLayout(records, previousManifest, () => new Map(), profile);

  assert.equal(layout.records.find((record) => record.id === 'old-a').layoutSlot, 7);
  assert.equal(layout.records.find((record) => record.id === 'old-b').layoutSlot, 8);
  assert.equal(layout.records.find((record) => record.id === 'new-edge').layoutSlot, 1);
  assert.equal(layout.layoutEvents.some((event) => event.eventType === 'layout.displaced'), false);
});

test('a full footprint expands on the spot instead of failing the build', () => {
  const profile = { cols: 6, rows: 4 };
  const records = [
    { id: 'old-a', tags: ['walk'], date: '2026-01-01', embedding: [1, 0] },
    { id: 'new-b', tags: ['walk'], date: '2026-01-02', embedding: [0, 1] },
  ];
  const previousManifest = {
    archiveView: {
      field: {
        regions: [
          {
            id: regionIdForTag('walk'),
            tag: 'walk',
            seedSlot: 0,
            footprint: { schemaVersion: 1, kind: 'rect', rect: { minCol: 0, maxCol: 0, minRow: 0, maxRow: 0 } },
          },
        ],
        records: [{ id: 'old-a', slot: 0 }],
      },
    },
    records: [],
  };

  const layout = incrementalRegionLayout(records, previousManifest, () => new Map(), profile);
  const region = layout.regions[0];

  assert.equal(layout.records.find((record) => record.id === 'old-a').layoutSlot, 0);
  assert.equal(isSlotInFootprint(layout.records.find((record) => record.id === 'new-b').layoutSlot, region.footprint, profile), true);
  assert.ok(footprintArea(region.footprint, profile) > 1);
  assert.ok(layout.layoutEvents.some((event) =>
    event.eventType === 'region.footprint_emergency_expanded' &&
    event.regionId === regionIdForTag('walk')
  ));
});

test('archive manifest persists projection axes as reusable state', () => {
  const projection = archiveManifest.embeddingProjection;
  assert.equal(projection.schemaVersion, 1);
  assert.equal(projection.method, 'variance-top2');
  assert.equal(projection.dimensions, 64);
  assert.equal(projection.embeddingModel, archiveManifest.semanticLayer.embeddingModel);
  assert.equal(Number.isInteger(projection.xAxis), true);
  assert.equal(Number.isInteger(projection.yAxis), true);
  assert.notEqual(projection.xAxis, projection.yAxis);
  assert.ok(projection.xAxis >= 0 && projection.xAxis < projection.dimensions);
  assert.ok(projection.yAxis >= 0 && projection.yAxis < projection.dimensions);
  assert.equal(typeof projection.createdAt, 'string');
});

test('archive manifest persists Region footprints and record region ids', () => {
  assert.equal(archiveManifest.schemaVersion, 10);
  assert.equal(archiveManifest.archiveView.field.schemaVersion, 2);
  assert.ok(Array.isArray(archiveManifest.archiveView.field.regions));
  assert.ok(archiveManifest.archiveView.field.regions.length > 0);

  for (const region of archiveManifest.archiveView.field.regions) {
    assert.equal(typeof region.id, 'string');
    assert.equal(typeof region.tag, 'string');
    assert.equal(Number.isInteger(region.seedSlot), true);
    assert.equal(typeof region.footprint.kind, 'string');
    assert.equal(typeof region.stats.density, 'number');
  }

  for (const record of archiveManifest.records) {
    assert.equal(typeof record.regionId, 'string');
  }
}
);

test('history layer schema stores observations rather than growth interpretations', () => {
  const schema = readFileSync(new URL('../supabase/archive-schema.sql', import.meta.url), 'utf8');

  assert.match(schema, /Store observations, not interpretations/);
  assert.match(schema, /create table if not exists public\.archive_rebuilds/);
  assert.match(schema, /create table if not exists public\.archive_record_snapshots/);
  assert.match(schema, /create table if not exists public\.archive_layout_events/);
  assert.match(schema, /changed_record_count integer not null default 0/);
  assert.match(schema, /content_hash text/);
  assert.doesNotMatch(schema, /archive_layout_events \([\s\S]*event_type text not null check/);
  assert.doesNotMatch(schema, /archive_record_snapshots \([\s\S]*created_at timestamptz/);
  assert.doesNotMatch(schema, /archive_layout_events \([\s\S]*created_at timestamptz/);
  assert.doesNotMatch(schema, /growth_role\s/);
  assert.doesNotMatch(schema, /growth_color\s/);
  assert.doesNotMatch(schema, /centrality_algorithm\s/);
});
