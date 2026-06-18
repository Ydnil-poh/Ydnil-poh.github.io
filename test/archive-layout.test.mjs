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
  rasterizeTextureLayoutGraph,
  textureRenderProfiles,
} from '../src/lib/archive/texturePipeline.mjs';
import { decodeTextureRenderPayload, isTextureRenderPayload } from '../src/lib/archive/textureRenderContract.mjs';

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
  assert.deepEqual(graph.canvas, { width: 32, height: 24, unit: 'cell' });
  assert.deepEqual(graph.nodes.map((node) => node.kind), ['textBlock', 'mediaBlock']);
  assert.equal(graph.nodes[0].lines.length, 2);
});

test('render payload validates against the runtime schema contract', () => {
  const graph = generateTextureLayoutGraph(extractSemanticBlocks('short paragraph', plainText));
  const raster = rasterizeTextureLayoutGraph(graph);
  const payload = generateTextureRenderPayload(raster, graph.canvas.width, graph.canvas.height, textureRenderProfiles.field);

  assert.equal(isTextureRenderPayload(payload), true);
  assert.equal(payload.width, 8);
  assert.equal(payload.height, 8);
  assert.equal(decodeTextureRenderPayload(payload).length, 64);
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
