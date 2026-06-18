import assert from 'node:assert/strict';
import test from 'node:test';

import { generateFieldViewModel } from '../src/lib/archive/fieldViewModel.mjs';
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
