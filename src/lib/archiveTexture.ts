import {
  assertTextureRenderPayload,
  decodeTextureRenderPayload,
  textureOpacityByValue,
} from './archive/textureRenderContract.mjs';
import type { TextureRenderPayload } from './archive/textureRenderContract.mjs';

type TextureRenderRole = 'field' | 'modal';
type TextureRenderSet = Partial<Record<TextureRenderRole, TextureRenderPayload>>;

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
  const roleOpacity = payload.role === 'field' ? 0.72 : 0.85;

  for (let y = 0; y < height; y += 1) {
    let x = 0;

    while (x < width) {
      const cellValue = cells[y * width + x];

      if (cellValue === 0) {
        x += 1;
        continue;
      }

      let runEnd = x + 1;
      while (runEnd < width && cells[y * width + runEnd] === cellValue) {
        runEnd += 1;
      }

      const opacity = (textureOpacityByValue[cellValue] ?? 1) * roleOpacity;

      rects.push(
        `<rect
          x="${x}"
          y="${y}"
          width="${runEnd - x}"
          height="1"
          fill="${payload.color}"
          opacity="${opacity.toFixed(3)}"
        />`
      );

      x = runEnd;
    }
  }

  return `<svg class="${payload.className}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">${rects.join('')}</svg>`;
}

export function renderTextureSet(renders: TextureRenderSet | undefined) {
  return {
    field: renderTextureSvg(renders?.field),
    modal: renderTextureSvg(renders?.modal),
  };
}
