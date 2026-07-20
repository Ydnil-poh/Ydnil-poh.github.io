export type TextureRleRun = [value: number, count: number];
export type TextureRenderPayload = {
  schemaVersion: 2;
  role?: string;
  lod: number;
  width: number;
  height: number;
  color: string;
  className: string;
  encoding: 'rle4';
  rle: TextureRleRun[];
};
export const textureRenderPayloadSchemaVersion: 2;
export const textureOpacityByValue: number[];
export const textureMaxCellValue: number;
export function isTextureRenderPayload(value: unknown): value is TextureRenderPayload;
export function assertTextureRenderPayload(value: unknown, label?: string): TextureRenderPayload;
export function normalizedCell(value: unknown): number;
export function decodeTextureRenderPayload(payload: TextureRenderPayload): number[];
