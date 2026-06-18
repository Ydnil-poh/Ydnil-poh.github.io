type TextureRleRun = [value: number, count: number];

type TextureRenderPayload = {
  width?: number;
  height?: number;
  minOpacity?: number;
  color?: string;
  className?: string;
  encoding?: 'rle4' | string;
  rle?: TextureRleRun[];
  cells?: number[];
};

const rle4OpacityByValue = [0.05, 0.24, 0.72, 0.85];

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function normalizedCell(value: unknown) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return 0;
  return clamp(numberValue, 0, 1);
}

function decodeTexturePayload(payload: TextureRenderPayload) {
  if (payload.encoding !== 'rle4') {
    return (payload.cells || []).map(normalizedCell);
  }

  const expectedLength = Math.max(1, Math.floor(payload.width || 1)) * Math.max(1, Math.floor(payload.height || 1));
  const cells: number[] = [];

  for (const run of payload.rle || []) {
    const [value, count] = run;
    const opacity = rle4OpacityByValue[value] ?? rle4OpacityByValue[0];
    const runLength = Math.max(0, Math.floor(Number(count) || 0));

    for (let index = 0; index < runLength && cells.length < expectedLength; index += 1) {
      cells.push(opacity);
    }
  }

  return cells;
}

export function renderTextureSvg(payload: TextureRenderPayload | undefined) {
  if (!payload) {
    return '<span class="texture-placeholder">no texture</span>';
  }

  const cells = decodeTexturePayload(payload);

  if (!cells.length) {
    return '<span class="texture-placeholder">no texture</span>';
  }

  const width = Math.max(1, Math.floor(payload.width || 1));
  const height = Math.max(1, Math.floor(payload.height || 1));
  const minOpacity = clamp(normalizedCell(payload.minOpacity ?? 0), 0, 1);
  const color = payload.color || 'currentColor';
  const className = payload.className || 'archive-texture';

  const rects = cells.slice(0, width * height).map((value, index) => {
    const x = index % width;
    const y = Math.floor(index / width);
    const opacity = clamp(Math.max(minOpacity, normalizedCell(value)), minOpacity, 1);

    return `<rect x="${x}" y="${y}" width="1" height="1" fill="${color}" opacity="${opacity.toFixed(3)}" />`;
  }).join('');

  return `<svg class="${className}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">${rects}</svg>`;
}
