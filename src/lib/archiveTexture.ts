import {
  assertTextureRenderPayload,
  decodeTextureRenderPayload,
  normalizedCell,
} from './archive/textureRenderContract.mjs';
import type { TextureRenderPayload } from './archive/textureRenderContract.mjs';

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

export function renderTextureSvg(payload: TextureRenderPayload | undefined) {
  if (!payload) {
    return '<span class="texture-placeholder">no texture</span>';
  }

  assertTextureRenderPayload(payload);
  const cells = decodeTextureRenderPayload(payload);

  if (!cells.length) {
    return '<span class="texture-placeholder">no texture</span>';
  }

  const width = Math.max(1, Math.floor(payload.width));
  const height = Math.max(1, Math.floor(payload.height));
  const minOpacity = clamp(normalizedCell(payload.minOpacity), 0, 1);

  const rects = cells.slice(0, width * height).map((value, index) => {
    const x = index % width;
    const y = Math.floor(index / width);
    const opacity = clamp(Math.max(minOpacity, normalizedCell(value)), minOpacity, 1);

    return `<rect x="${x}" y="${y}" width="1" height="1" fill="${payload.color}" opacity="${opacity.toFixed(3)}" />`;
  }).join('');

  return `<svg class="${payload.className}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">${rects}</svg>`;
}
