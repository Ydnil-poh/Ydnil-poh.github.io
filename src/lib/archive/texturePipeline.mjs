import { assertTextureRenderPayload, textureMaxCellValue, textureRenderPayloadSchemaVersion } from './textureRenderContract.mjs';

export const textureLayoutProfile = {
  width: 64,
  height: 48,
  margin: 4,
  paragraphGap: 1,
  youtubeBlockHeight: 8,
};

export const textureRenderProfiles = {
  field: {
    role: 'field',
    lod: 0,
    width: 24,
    height: 18,
    color: 'currentColor',
    className: 'archive-texture archive-texture--field',
  },
  modal: {
    role: 'modal',
    lod: 1,
    width: 64,
    height: 48,
    color: 'currentColor',
    className: 'archive-texture archive-texture--modal',
  },
};

export function youtubeDirectiveUrl(block) {
  const match = block.trim().match(/^!youtube\s+(https?:\/\/(?:www\.)?(?:youtube\.com|youtu\.be)\/\S+)/i);
  return match?.[1] ?? null;
}

export function quantizeTextureOpacity(opacity) {
  const numeric = Number(opacity);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return Math.min(textureMaxCellValue, Math.round(numeric * textureMaxCellValue));
}

// Field tiles render at roughly 25px wide, so a cell must stay near or above
// a screen pixel for the step to read: 12x9 is visibly blocky, 24x18 is the
// baseline grain, 40x30 reads as smooth. Linear 1.33x steps were
// indistinguishable at tile scale.
export const textureLodRenderResolutions = {
  0: { width: 12, height: 9 },
  1: { width: 24, height: 18 },
  2: { width: 40, height: 30 },
};

// allowedTones limits the tone palette per LOD so fidelity reads at tile
// scale even where resolution steps are sub-pixel: LOD0 is one flat mid tone,
// LOD1 splits into light/full, LOD2 keeps the whole palette.
export const textureLodPolicies = {
  0: {
    lod: 0,
    coverageThreshold: 0.6,
    removeIsolatedPixels: true,
    minimumBlockSize: 2,
    preserveThinLines: false,
    allowedTones: [2],
  },
  1: {
    lod: 1,
    coverageThreshold: 0.45,
    removeIsolatedPixels: false,
    minimumBlockSize: 1,
    preserveThinLines: false,
    allowedTones: [1, 3],
  },
  2: {
    lod: 2,
    coverageThreshold: 0.3,
    removeIsolatedPixels: false,
    minimumBlockSize: 1,
    preserveThinLines: true,
    allowedTones: [1, 2, 3],
  },
};

// Nearest allowed tone; ties resolve to the darker tone so mid coverage never
// fades below its LOD1 light/full split. Zero (paper) always passes through.
export function remapToneForPolicy(tone, policy) {
  const allowed = policy?.allowedTones;
  if (tone === 0 || !Array.isArray(allowed) || allowed.length === 0 || allowed.includes(tone)) return tone;
  let best = allowed[0];
  for (const candidate of allowed) {
    const candidateDistance = Math.abs(candidate - tone);
    const bestDistance = Math.abs(best - tone);
    if (candidateDistance < bestDistance || (candidateDistance === bestDistance && candidate > best)) {
      best = candidate;
    }
  }
  return best;
}

export function semanticDensityForScore(score) {
  const numericScore = Number(score);
  if (!Number.isFinite(numericScore)) return 'low';
  if (numericScore > 0.72) return 'high';
  if (numericScore > 0.38) return 'medium';
  return 'low';
}

export function runtimeLodForNormalizedScore(normalizedRuntime) {
  const numericScore = Number(normalizedRuntime);
  if (!Number.isFinite(numericScore)) return 0;
  if (numericScore > 0.72) return 2;
  if (numericScore > 0.38) return 1;
  return 0;
}

// LOD listens to both observation channels: human runtime score and machine
// score (user-delegated AI reads). Both are attention, neither moves geometry.
export function attentionScoreFor(record) {
  const runtimeScore = Math.max(0, Number(record?.runtimeScore ?? record?.attentionSnapshot?.runtimeScore ?? 0) || 0);
  const machineScore = Math.max(0, Number(record?.machineScore ?? record?.attentionSnapshot?.machineScore ?? 0) || 0);
  return runtimeScore + machineScore;
}

export function normalizedRuntimeScore(record, runtimeScale = 0) {
  const scale = Number(runtimeScale);
  if (!Number.isFinite(scale) || scale <= 0) return 0;
  const attentionScore = attentionScoreFor(record);
  if (!Number.isFinite(attentionScore)) return 0;
  return Math.log1p(attentionScore) / scale;
}

// Human and machine attention render through separate channels, because
// they live on incompatible scales: human events accumulate per visitor
// (2–25 per record in practice) while a machine (user-delegated AI) read is
// one canonical unit of 0.30 per agent-day. A ratio-based hue could never
// surface the machine side — measured against real logs, every record
// rendered 'human'. So hue encodes only human attention presence, and
// machine attention is a discrete existence marker: sparse signals are
// rendered as presence, not magnitude.
export function attentionSourceFor(record) {
  const human = Math.max(0, Number(record?.runtimeScore ?? record?.attentionSnapshot?.runtimeScore ?? 0) || 0);
  return human > 0 ? 'human' : 'none';
}

// One canonical AI read (a full-confidence agent-day) earns the marker; a
// lone unverified UA match (0.18) does not.
export const machineAttentionThreshold = 0.3;

export function hasMachineAttention(record) {
  const machine = Math.max(0, Number(record?.machineScore ?? record?.attentionSnapshot?.machineScore ?? 0) || 0);
  return machine >= machineAttentionThreshold;
}

export function encodeRle4(values) {
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

export function extractSemanticBlocks(rawBody, plainText) {
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

export function generateTextureLayoutGraph(blocks, options = {}) {
  const profile = options.profile ?? textureLayoutProfile;
  const recordType = options.type ?? 'standard';
  const galleryCount = options.galleryImageCount ?? 0;

  const isMediaRail = recordType === 'mediaRail' && galleryCount > 0;
  const railWidth = isMediaRail ? 6 : 0;
  const railGap = isMediaRail ? 2 : 0;
  const textX = profile.margin + railWidth + railGap;
  const textWidth = profile.width - profile.margin - textX;

  let cursorY = 0;
  const nodes = [];

  if (isMediaRail) {
    const imageHeight = 4;
    const imageGap = 1;
    let railCursorY = 0;

    for (let i = 0; i < galleryCount && railCursorY + imageHeight <= profile.height; i += 1) {
      nodes.push({
        id: `node-${nodes.length}`,
        kind: 'imageBlock',
        sourceBlockId: `gallery-${i}`,
        x: profile.margin,
        y: railCursorY,
        width: railWidth,
        height: imageHeight,
      });
      railCursorY += imageHeight + imageGap;
    }
  }

    for (const block of blocks) {
      if (cursorY >= profile.height) break;

      if (block.kind === 'youtube') {

        const youtubeHeight = Math.max(
          10,
          Math.round(textWidth * 0.35)
        );

    const height = Math.min(
      youtubeHeight,
      profile.height - cursorY
    );  
      nodes.push({
        id: `node-${nodes.length}`,
        kind: 'mediaBlock',
        mediaType: 'youtube',
        sourceBlockId: block.id,
        x: textX,
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
          x: textX,
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
  return Array.from({ length: width * height }, () => 0);
}

function paintTextureCell(canvas, width, height, x, y, value) {
  if (x < 0 || x >= width || y < 0 || y >= height) return;
  canvas[y * width + x] = Math.max(0, Math.min(textureMaxCellValue, Math.floor(Number(value) || 0)));
}

function rasterizeTextBlock(canvas, graph, node) {
  for (let lineIndex = 0; lineIndex < node.lines.length; lineIndex += 1) {
    const line = node.lines[lineIndex];
    const y = node.y + lineIndex;
    for (let x = node.x; x < node.x + node.width; x += 1) {
      const insideText = x < node.x + line.fillWidth;
      paintTextureCell(canvas, graph.canvas.width, graph.canvas.height, x, y, insideText ? textureMaxCellValue : 0);
    }
  }
}

function rasterizeMediaBlock(canvas, graph, node) {
  for (let y = node.y; y < node.y + node.height; y += 1) {
    const isHorizontalEdge = y === node.y || y === node.y + node.height - 1;

    for (let x = node.x; x < node.x + node.width; x += 1) {
      const isVerticalEdge = x === node.x || x === node.x + node.width - 1;
      const centerX = Math.floor(node.x + node.width / 2);  
      const centerY = Math.floor(node.y + node.height / 2);
      
      const playMarker =
        (x === centerX - 1 && y === centerY - 1) ||
        (x === centerX - 1 && y === centerY) ||
        (x === centerX - 1 && y === centerY + 1) ||
        (x === centerX && y === centerY) ||
        (x === centerX + 1 && y === centerY);

      if (isHorizontalEdge || isVerticalEdge || playMarker) {
        paintTextureCell(canvas, graph.canvas.width, graph.canvas.height, x, y, textureMaxCellValue);
      } else {
        // screen fill: a light tone so the media block reads as a surface, not an outline
        paintTextureCell(canvas, graph.canvas.width, graph.canvas.height, x, y, 1);
      }
    }
  }
}

function rasterizeImageBlock(canvas, graph, node) {
  for (let y = node.y; y < node.y + node.height; y += 1) {
    const isHorizontalEdge = y === node.y || y === node.y + node.height - 1;

    for (let x = node.x; x < node.x + node.width; x += 1) {
      const isVerticalEdge = x === node.x || x === node.x + node.width - 1;

      if (isHorizontalEdge || isVerticalEdge) {
        paintTextureCell(canvas, graph.canvas.width, graph.canvas.height, x, y, textureMaxCellValue);
      } else {
        paintTextureCell(canvas, graph.canvas.width, graph.canvas.height, x, y, 1);
      }
    }
  }
}

const textureRasterizers = {
  textBlock: rasterizeTextBlock,
  mediaBlock: rasterizeMediaBlock,
  imageBlock: rasterizeImageBlock,
};

export function rasterizeTextureLayoutGraph(graph) {
  const canvas = createTextureCanvas(graph.canvas.width, graph.canvas.height);

  for (const node of graph.nodes) {
    textureRasterizers[node.kind]?.(canvas, graph, node);
  }

  return canvas;
}

function neighborCount(values, width, height, x, y) {
  let count = 0;

  for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
    for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
      if (offsetX === 0 && offsetY === 0) continue;
      const neighborX = x + offsetX;
      const neighborY = y + offsetY;
      if (neighborX < 0 || neighborX >= width || neighborY < 0 || neighborY >= height) continue;
      count += values[neighborY * width + neighborX] ? 1 : 0;
    }
  }

  return count;
}

function removeSmallTextureBlocks(values, width, height, minimumBlockSize) {
  if (minimumBlockSize <= 1) return values;

  const nextValues = [...values];
  const visited = new Set();

  for (let index = 0; index < values.length; index += 1) {
    if (!values[index] || visited.has(index)) continue;

    const component = [];
    const queue = [index];
    visited.add(index);

    for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
      const currentIndex = queue[queueIndex];
      component.push(currentIndex);
      const x = currentIndex % width;
      const y = Math.floor(currentIndex / width);
      const neighbors = [
        [x - 1, y],
        [x + 1, y],
        [x, y - 1],
        [x, y + 1],
      ];

      for (const [neighborX, neighborY] of neighbors) {
        if (neighborX < 0 || neighborX >= width || neighborY < 0 || neighborY >= height) continue;
        const neighborIndex = neighborY * width + neighborX;
        if (!values[neighborIndex] || visited.has(neighborIndex)) continue;
        visited.add(neighborIndex);
        queue.push(neighborIndex);
      }
    }

    if (component.length < minimumBlockSize) {
      for (const componentIndex of component) {
        nextValues[componentIndex] = 0;
      }
    }
  }

  return nextValues;
}

function applyTextureLodMorphology(values, width, height, policy) {
  let nextValues = values;

  if (policy.removeIsolatedPixels) {
    nextValues = nextValues.map((value, index) => {
      if (!value) return 0;
      const x = index % width;
      const y = Math.floor(index / width);
      return neighborCount(nextValues, width, height, x, y) > 0 ? value : 0;
    });
  }

  return removeSmallTextureBlocks(nextValues, width, height, policy.minimumBlockSize ?? 1);
}

export function downsampleQuantizedTexture(sourceValues, sourceWidth, sourceHeight, targetWidth, targetHeight, policy = textureLodPolicies[0]) {
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
          total += sourceValues[sourceY * sourceWidth + sourceX];
          count += 1;
        }
      }

      // ink fraction: source cells are tone levels 0..max, so normalize by the
      // maximum so thresholds keep their original visible-set semantics
      const coverage = count > 0 ? total / (count * textureMaxCellValue) : 0;
      const hasThinLine = policy.preserveThinLines && total > 0;
      values.push(coverage >= policy.coverageThreshold || hasThinLine
        ? remapToneForPolicy(Math.max(1, quantizeTextureOpacity(coverage)), policy)
        : 0);
    }
  }

  return applyTextureLodMorphology(values, targetWidth, targetHeight, policy);
}

export function textureRenderResolutionForLod(lod) {
  return textureLodRenderResolutions[lod] ?? textureLodRenderResolutions[0];
}

export function generateTextureRenderPayload(sourceValues, sourceWidth, sourceHeight, profile, lodPolicy = textureLodPolicies[profile.lod] ?? textureLodPolicies[0]) {
  const usesSourceMask = profile.role === 'modal' || (profile.width === sourceWidth && profile.height === sourceHeight);
  const renderLod = usesSourceMask ? profile.lod : lodPolicy.lod;
  const targetResolution = usesSourceMask
    ? { width: sourceWidth, height: sourceHeight }
    : textureRenderResolutionForLod(renderLod);
  const values = usesSourceMask
    ? sourceValues
    : downsampleQuantizedTexture(
      sourceValues,
      sourceWidth,
      sourceHeight,
      targetResolution.width,
      targetResolution.height,
      lodPolicy
    );

  return assertTextureRenderPayload({
    schemaVersion: textureRenderPayloadSchemaVersion,
    role: profile.role,
    lod: renderLod,
    width: targetResolution.width,
    height: targetResolution.height,
    color: profile.color,
    className: profile.className,
    encoding: 'rle4',
    rle: encodeRle4(values),
  }, `${profile.role} texture render payload`);
}

export function generateTextureViewModel(record, plainText, options = {}) {
  const semanticBlocks = extractSemanticBlocks(record.rawBody, plainText);
  const layoutGraph = generateTextureLayoutGraph(semanticBlocks, {
    type: record.type,
    galleryImageCount: record.galleryImageUrls?.length ?? 0,
  });
  const rasterValues = rasterizeTextureLayoutGraph(layoutGraph);
  const normalizedRuntime = options.normalizedRuntime ?? normalizedRuntimeScore(record, options.runtimeLodScale);
  const runtimeLod = runtimeLodForNormalizedScore(normalizedRuntime);
  const lodPolicy = textureLodPolicies[runtimeLod];

  return {
    texture: {
      schemaVersion: 2,
      density: semanticDensityForScore(record.score),
      imageCount: record.imageUrls.length + record.galleryImageUrls.length,
      textLength: record.textLength,
      layout: {
        schemaVersion: layoutGraph.schemaVersion,
        nodeCount: layoutGraph.nodes.length,
        canvas: layoutGraph.canvas,
        documentType: record.type,
      },
      renders: Object.fromEntries(
        Object.entries(textureRenderProfiles).map(([key, profile]) => [
          key,
          generateTextureRenderPayload(
            rasterValues,
            layoutGraph.canvas.width,
            layoutGraph.canvas.height,
            profile,
            profile.role === 'field' ? lodPolicy : undefined
          ),
        ])
      ),
    },
    debug: {
      semanticBlocks,
      layoutGraph,
    },
  };
}
