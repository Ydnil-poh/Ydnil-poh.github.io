import { renderTextureSet } from '../archiveTexture.ts';

export function createArchiveIndexView(manifest) {
  const fieldView = manifest.archiveView.field;
  const cols = fieldView.cols;
  const rows = fieldView.rows;
  const totalSlots = cols * rows;
  const recordByIdFromManifest = new Map(manifest.records.map((record) => [record.id, record]));

  const fieldRecords = fieldView.records.map((fieldRecord) => {
    const record = recordByIdFromManifest.get(fieldRecord.id);
    if (!record) return null;
    
    return {
      ...record,
      field: fieldRecord,
      textureSvg: renderTextureSet(record.texture?.renders),
    };
  }).filter((record) => record !== null);

  const occupiedSlots = new Set(fieldView.records.map((record) => record.slot));
  const emptyTiles = Array.from({ length: totalSlots }, (_, slot) => ({
    slot,
    col: slot % cols,
    row: Math.floor(slot / cols),
    tone: (slot * 13 + Math.floor(slot / cols) * 7) % 9,
  })).filter((tile) => !occupiedSlots.has(tile.slot));

  const traces = (fieldView.traces ?? [])
    .map((trace) => {
      const record = recordByIdFromManifest.get(trace.recordId);
      if (!record) return null;
      return {
        slot: trace.slot,
        col: trace.col,
        row: trace.row,
        recordId: trace.recordId,
        textureSvg: renderTextureSet(record.texture?.renders).field,
      };
    })
    .filter((trace) => trace !== null && !occupiedSlots.has(trace.slot));

  const clientRecords = fieldRecords.map(({ textureSvg, texture, ...record }) => ({
    ...record,
    textureSvg: {
      modal: textureSvg.modal,
    },
  }));

  return {
    fieldView,
    cols,
    rows,
    totalSlots,
    fieldRecords,
    emptyTiles,
    traces,
    clientRecords,
    recordById: new Map(fieldRecords.map((record) => [record.id, record])),
    selected: fieldRecords[0],
  };
}
