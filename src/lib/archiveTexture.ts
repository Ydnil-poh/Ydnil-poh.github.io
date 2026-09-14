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

// The texture's negative space: rects covering exactly the cells the render
// leaves empty (margins, line gaps, paragraph gaps). Overlaying it in another
// color patterns the ground between the ink without touching the ink itself —
// the two attention channels share one tile in complementary space. Fill is
// full-strength currentColor; the overlay element grades the strength.
export function renderTextureInverseSvg(payload: TextureRenderPayload | undefined) {
  if (!payload) {
    return '';
  }

  assertTextureRenderPayload(payload);

  const width = Math.max(1, Math.floor(payload.width));
  const height = Math.max(1, Math.floor(payload.height));

  const cells = decodeTextureRenderPayload(payload);
  const rects: string[] = [];

  for (let y = 0; y < height; y += 1) {
    let x = 0;

    while (x < width) {
      if ((cells[y * width + x] ?? 0) !== 0) {
        x += 1;
        continue;
      }

      let runEnd = x + 1;
      while (runEnd < width && (cells[y * width + runEnd] ?? 0) === 0) {
        runEnd += 1;
      }

      rects.push(`<rect x="${x}" y="${y}" width="${runEnd - x}" height="1" fill="${payload.color}"/>`);

      x = runEnd;
    }
  }

  return `<svg class="${payload.className} archive-texture--inverse" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">${rects.join('')}</svg>`;
}

export function renderTextureSet(renders: TextureRenderSet | undefined) {
  return {
    field: renderTextureSvg(renders?.field),
    modal: renderTextureSvg(renders?.modal),
  };
}
