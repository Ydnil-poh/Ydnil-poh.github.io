export const textureOpacityByValue = [0.05, 0.24, 0.72, 0.85];

export function isTextureRenderPayload(value) {
  return Boolean(
    value &&
    typeof value === 'object' &&
    value.schemaVersion === 1 &&
    Number.isInteger(value.lod) &&
    Number.isFinite(Number(value.width)) &&
    Number.isFinite(Number(value.height)) &&
    Number.isFinite(Number(value.minOpacity)) &&
    typeof value.color === 'string' &&
    typeof value.className === 'string' &&
    value.encoding === 'rle4' &&
    Array.isArray(value.rle) &&
    value.rle.every((run) => Array.isArray(run) && run.length === 2 && Number.isInteger(run[0]) && Number.isInteger(run[1]))
  );
}

export function assertTextureRenderPayload(value, label = 'texture render payload') {
  if (!isTextureRenderPayload(value)) {
    throw new TypeError(`${label} does not match TextureRenderPayload schemaVersion 1`);
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
    const opacity = textureOpacityByValue[value] ?? textureOpacityByValue[0];
    const runLength = Math.max(0, Math.floor(Number(count) || 0));

    for (let index = 0; index < runLength && cells.length < expectedLength; index += 1) {
      cells.push(opacity);
    }
  }

  return cells;
}
