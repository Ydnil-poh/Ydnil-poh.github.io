export const textureRenderPayloadSchemaVersion = 2;

// Cell values are tone levels, not a binary mask: 0 = paper, 1..3 = ink density.
// The renderer resolves a level to opacity through this table; rle4 leaves head
// room up to 15 levels if the palette ever needs more.
export const textureOpacityByValue = [0, 0.35, 0.65, 1];
export const textureMaxCellValue = textureOpacityByValue.length - 1;

function isToneLevel(value) {
  return Number.isInteger(value) && value >= 0 && value <= textureMaxCellValue;
}

export function isTextureRenderPayload(value) {
  return Boolean(
    value &&
    typeof value === 'object' &&
    value.schemaVersion === textureRenderPayloadSchemaVersion &&
    Number.isInteger(value.lod) &&
    Number.isInteger(value.width) &&
    value.width > 0 &&
    Number.isInteger(value.height) &&
    value.height > 0 &&
    typeof value.color === 'string' &&
    typeof value.className === 'string' &&
    value.encoding === 'rle4' &&
    Array.isArray(value.rle) &&
    value.rle.every((run) => Array.isArray(run) && run.length === 2 && isToneLevel(run[0]) && Number.isInteger(run[1]) && run[1] > 0)
  );
}

export function assertTextureRenderPayload(value, label = 'texture render payload') {
  if (!isTextureRenderPayload(value)) {
    throw new TypeError(`${label} does not match TextureRenderPayload schemaVersion ${textureRenderPayloadSchemaVersion}`);
  }
  return value;
}

export function normalizedCell(value) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return 0;
  return Math.max(0, Math.min(1, numberValue));
}

export function decodeTextureRenderPayload(payload) {
  assertTextureRenderPayload(payload);
  const width = Math.max(1, Math.floor(payload.width));
  const height = Math.max(1, Math.floor(payload.height));
  const expectedLength = width * height;
  const cells = [];

  for (const run of payload.rle) {
    const [value, count] = run;
    const cellValue = isToneLevel(Number(value)) ? Number(value) : 0;
    const runLength = Math.max(0, Math.floor(Number(count) || 0));

    for (let index = 0; index < runLength && cells.length < expectedLength; index += 1) {
      cells.push(cellValue);
    }
  }

  return cells;
}
