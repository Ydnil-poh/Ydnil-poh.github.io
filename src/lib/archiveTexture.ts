import {
  assertTextureRenderPayload,
  textureOpacityByValue,
  normalizedCell,
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
  const minOpacity = clamp(normalizedCell(payload.minOpacity), 0, 1);

  const rects: string[] = [];
  let index = 0;

  for (const run of payload.rle) {
    const [value, count] = run;
    const baseOpacity = textureOpacityByValue[value] ?? textureOpacityByValue[0];
    const opacity = clamp(Math.max(minOpacity, normalizedCell(baseOpacity)), minOpacity, 1);
    
    let remaining = Math.max(0, Math.floor(Number(count) || 0));

    while (remaining > 0 && index < width * height) {
      const x = index % width;
      const y = Math.floor(index / width);
      const rowRemaining = width - x;
      const chunk = Math.min(remaining, rowRemaining);

      rects.push(`<rect x="${x}" y="${y}" width="${chunk}" height="1" fill="${payload.color}" opacity="${opacity.toFixed(3)}" />`);

      index += chunk;
      remaining -= chunk;
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
