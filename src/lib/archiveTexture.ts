export type TextureRenderVariant = 'field' | 'modal';

type ArchiveTexture = {
  cells?: number[];
  width?: number;
  height?: number;
  density?: 'high' | 'medium' | 'low' | string;
};

type TextureProfile = {
  width: number;
  height: number;
  minOpacity: number;
  color: string;
  className: string;
};

const profiles: Record<TextureRenderVariant, TextureProfile> = {
  field: {
    width: 8,
    height: 8,
    minOpacity: 0.12,
    color: 'currentColor',
    className: 'archive-texture archive-texture--field',
  },
  modal: {
    width: 32,
    height: 32,
    minOpacity: 0.05,
    color: 'currentColor',
    className: 'archive-texture archive-texture--modal',
  },
};

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function normalizedCell(value: unknown) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return 0;
  return clamp(numberValue, 0, 1);
}

function downsampleTexture(texture: ArchiveTexture, targetWidth: number, targetHeight: number) {
  const sourceWidth = Math.max(1, Math.floor(texture.width || 32));
  const sourceHeight = Math.max(1, Math.floor(texture.height || 32));
  const sourceCells = texture.cells || [];
  const cells: number[] = [];

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
          const index = sourceY * sourceWidth + sourceX;
          total += normalizedCell(sourceCells[index]);
          count += 1;
        }
      }

      cells.push(count > 0 ? total / count : 0);
    }
  }

  return cells;
}

export function renderTextureSvg(texture: ArchiveTexture | undefined, variant: TextureRenderVariant) {
  const profile = profiles[variant];

  if (!texture?.cells?.length) {
    return '<span class="texture-placeholder">no texture</span>';
  }

  const sourceWidth = Math.max(1, Math.floor(texture.width || 32));
  const sourceHeight = Math.max(1, Math.floor(texture.height || 32));
  const useNativeResolution = sourceWidth === profile.width && sourceHeight === profile.height;
  const cells = useNativeResolution
    ? texture.cells.map(normalizedCell)
    : downsampleTexture(texture, profile.width, profile.height);

  const rects = cells.map((value, index) => {
    const x = index % profile.width;
    const y = Math.floor(index / profile.width);
    const opacity = clamp(Math.max(profile.minOpacity, value), profile.minOpacity, 1);

    return `<rect x="${x}" y="${y}" width="1" height="1" fill="${profile.color}" opacity="${opacity.toFixed(3)}" />`;
  }).join('');

  return `<svg class="${profile.className}" viewBox="0 0 ${profile.width} ${profile.height}" preserveAspectRatio="none" aria-hidden="true">${rects}</svg>`;
}
