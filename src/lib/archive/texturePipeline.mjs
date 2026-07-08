import { assertTextureRenderPayload, textureOpacityByValue } from './textureRenderContract.mjs';

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
    width: 24,
    height: 18,
    minOpacity: 0.12,
    color: 'currentColor',
    className: 'archive-texture archive-texture--field',
  },
  modal: {
    role: 'modal',
    width: 64,
    height: 48,
    minOpacity: 0.05,
    color: 'currentColor',
    className: 'archive-texture archive-texture--modal',
  },
};

export function youtubeDirectiveUrl(block) {
  const match = block.trim().match(/^!youtube\s+(https?:\/\/(?:www\.)?(?:youtube\.com|youtu\.be)\/\S+)/i);
  return match?.[1] ?? null;
}

export function quantizeTextureOpacity(opacity) {
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

      if (block.kind === 'youtube') {

        const youtubeHeight = Math.max(10, Math.round(textWidth * 0.35)
        );

        const height = Math.min(youtubeHeight, profile.height - cursorY
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

function rasterizeImageBlock(canvas, graph, node) {
  for (let y = node.y; y < node.y + node.height; y += 1) {
    const isHorizontalEdge = y === node.y || y === node.y + node.height - 1;

    for (let x = node.x; x < node.x + node.width; x += 1) {
      const isVerticalEdge = x === node.x || x === node.x + node.width - 1;

      if (isHorizontalEdge || isVerticalEdge) {
        paintTextureCell(canvas, graph.canvas.width, graph.canvas.height, x, y, 0.72);
      } else {
        paintTextureCell(canvas, graph.canvas.width, graph.canvas.height, x, y, 0.24);
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

function cellOpacity(value) {
  return textureOpacityByValue[value] ?? textureOpacityByValue[0];
}

export function downsampleQuantizedTexture(sourceValues, sourceWidth, sourceHeight, targetWidth, targetHeight) {
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

export function generateTextureRenderPayload(sourceValues, sourceWidth, sourceHeight, profile) {
  const values = sourceWidth === profile.width && sourceHeight === profile.height
    ? sourceValues
    : downsampleQuantizedTexture(sourceValues, sourceWidth, sourceHeight, profile.width, profile.height);

  return assertTextureRenderPayload({
    schemaVersion: 1,
    role: profile.role,
    width: profile.width,
    height: profile.height,
    minOpacity: profile.minOpacity,
    color: profile.color,
    className: profile.className,
    encoding: 'rle4',
    rle: encodeRle4(values),
  }, `${profile.role} texture render payload`);
}

export function generateTextureViewModel(record, plainText) {
  const semanticBlocks = extractSemanticBlocks(record.rawBody, plainText);
  const layoutGraph = generateTextureLayoutGraph(semanticBlocks, {
    type: record.type,
    galleryImageCount: record.galleryImageUrls?.length ?? 0,
  });
  const rasterValues = rasterizeTextureLayoutGraph(layoutGraph);

  return {
    texture: {
      schemaVersion: 2,
      density: record.score > 0.72 ? 'high' : record.score > 0.38 ? 'medium' : 'low',
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
          generateTextureRenderPayload(rasterValues, layoutGraph.canvas.width, layoutGraph.canvas.height, profile),
        ])
      ),
    },
    debug: {
      semanticBlocks,
      layoutGraph,
    },
  };
}
