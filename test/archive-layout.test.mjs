import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import archiveManifest from '../public/archive-manifest.json' with { type: 'json' };

import { generateFieldViewModel } from '../src/lib/archive/fieldViewModel.mjs';
import { renderTextureSet } from '../src/lib/archiveTexture.ts';
import { createArchiveIndexView } from '../src/lib/archive/pageViewModel.mjs';
import {
  extractSemanticBlocks,
  generateTextureLayoutGraph,
  generateTextureRenderPayload,
  generateTextureViewModel,
  rasterizeTextureLayoutGraph,
  semanticLodForScore,
  textureLodPolicies,
  textureRenderProfiles,
} from '../src/lib/archive/texturePipeline.mjs';
import { decodeTextureRenderPayload, isTextureRenderPayload } from '../src/lib/archive/textureRenderContract.mjs';

import {
  calculateRegionStats,
  createRectFootprintAroundSeed,
  incrementalRegionLayout,
  isSlotInFootprint,
  nearestOpenSlotInFootprint,
  regionIdForTag,
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
  assert.equal(payload.width, 24);
  assert.equal(payload.height, 18);
  assert.equal(decodeTextureRenderPayload(payload).length, 432);
});

test('semantic score selects an LOD policy for texture downsampling', () => {
  assert.equal(semanticLodForScore(0.2), 0);
  assert.equal(semanticLodForScore(0.5), 1);
  assert.equal(semanticLodForScore(0.9), 2);
  assert.equal(textureLodPolicies[0].coverageThreshold, 0.6);
  assert.equal(textureLodPolicies[1].coverageThreshold, 0.45);
  assert.equal(textureLodPolicies[2].coverageThreshold, 0.3);
  assert.equal(textureLodPolicies[2].preserveThinLines, true);
});

test('semantic LOD is applied only to field render payloads', () => {
  const view = generateTextureViewModel({
    rawBody: 'semantic density should simplify field only',
    type: 'standard',
    score: 0.9,
    imageUrls: [],
    galleryImageUrls: [],
    textLength: 43,
  }, plainText);

  assert.equal(view.texture.renders.field.lod, 2);
  assert.equal(view.texture.renders.field.width, 24);
  assert.equal(view.texture.renders.field.height, 18);
  assert.equal(view.texture.renders.modal.lod, 1);
  assert.equal(view.texture.renders.modal.width, 64);
  assert.equal(view.texture.renders.modal.height, 48);
  assert.deepEqual(
    decodeTextureRenderPayload(view.texture.renders.modal),
    rasterizeTextureLayoutGraph(view.debug.layoutGraph)
  );
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

test('Sleep Rebuild applies attention drift inside an existing Region footprint', () => {
  const profile = { cols: 6, rows: 4 };
  const records = [
    {
      id: 'old-a',
      tags: ['walk'],
      date: '2026-01-01',
      embedding: [1, 0],
      attentionSnapshot: { humanScore: 10 },
    },
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
        records: [{ id: 'old-a', slot: 7 }],
      },
    },
    records: [],
  };

  const layout = incrementalRegionLayout(records, previousManifest, () => new Map(), profile, {
    sleepRebuild: true,
    attentionDriftScale: Math.log1p(10),
  });

  const record = layout.records[0];
  assert.notEqual(record.layoutSlot, 7);
  assert.equal(isSlotInFootprint(record.layoutSlot, layout.regions[0].footprint, profile), true);
  assert.ok(layout.layoutEvents.some((event) =>
    event.eventType === 'layout.moved_within_region' &&
    event.recordId === 'old-a' &&
    event.metadata.attentionDrifted === true
  ));
});

test('archive manifest persists Region footprints and record region ids', () => {
  assert.equal(archiveManifest.schemaVersion, 7);
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
