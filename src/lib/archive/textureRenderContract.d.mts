export type TextureRleRun = [value: number, count: number];
export type TextureRenderPayload = {
  schemaVersion: 1;
  role?: string;
  width: number;
  height: number;
  minOpacity: number;
  color: string;
  className: string;
  encoding: 'rle4';
  rle: TextureRleRun[];
};
export const textureOpacityByValue: number[];
export function isTextureRenderPayload(value: unknown): value is TextureRenderPayload;
export function assertTextureRenderPayload(value: unknown, label?: string): TextureRenderPayload;
export function normalizedCell(value: unknown): number;
export function decodeTextureRenderPayload(payload: TextureRenderPayload): number[];
