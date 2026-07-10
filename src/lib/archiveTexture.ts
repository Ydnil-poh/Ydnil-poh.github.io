import {
  assertTextureRenderPayload,
  decodeTextureRenderPayload,
} from './archive/textureRenderContract.mjs';
import type { TextureRenderPayload } from './archive/textureRenderContract.mjs';

type TextureRenderRole = 'field' | 'modal';
type TextureRenderSet = Partial<Record<TextureRenderRole, TextureRenderPayload>>;

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function texturePlaceholder() {
  return '<span class="texture-placeholder">no texture</span>';
}

export function renderTextureSvg(payload: TextureRenderPayload | undefined) {
  if (!payload) {
    return texturePlaceholder();
  }

  assertTextureRenderPayload(payload);

  if (!payload.rle || !payload.rle.length) {
    return texturePlaceholder();
  }

  const width = Math.max(1, Math.floor(payload.width));
  const height = Math.max(1, Math.floor(payload.height));

  const cells = decodeTextureRenderPayload(payload);
  const rects: string[] = [];

  for (let index = 0; index < cells.length; index += 1) {
    const cellValue = cells[index];

    if (cellValue === 0) {
      continue;
    }

    const x = index % width;
    const y = Math.floor(index / width);

    const opacity =
      payload.role === 'field'
        ? 0.72
        : 0.85;

    rects.push(
      `<rect
        x="${x}"
        y="${y}"
        width="1"
        height="1"
        fill="${payload.color}"
        opacity="${opacity.toFixed(3)}"
      />`
    );
    }
    
    if (index >= width * height) break;
  }

  return `<svg class="${payload.className}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">${rects.join('')}</svg>`;
}

export function renderTextureSet(renders: TextureRenderSet | undefined) {
  return {
    field: renderTextureSvg(renders?.field),
    modal: renderTextureSvg(renders?.modal),
  };
}
