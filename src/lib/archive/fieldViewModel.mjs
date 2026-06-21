export const fieldLayoutProfile = {
  cols: 50,
  rows: 30,
};

export function nearestOpenSlot(preferred, occupied, profile = fieldLayoutProfile) {
  if (!occupied.has(preferred)) return preferred;
  const totalSlots = profile.cols * profile.rows;
  const preferredCol = preferred % profile.cols;
  const preferredRow = Math.floor(preferred / profile.cols);
  let best = -1;
  let bestDistance = Infinity;

  for (let index = 0; index < totalSlots; index += 1) {
    if (occupied.has(index)) continue;
    const col = index % profile.cols;
    const row = Math.floor(index / profile.cols);
    const distance = Math.abs(col - preferredCol) + Math.abs(row - preferredRow);
    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  }
  return best;
}

export function generateFieldViewModel(records, profile = fieldLayoutProfile) {
  const occupied = new Set();
  const latestRecordId = [...records]
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())[0]?.id;
  const fieldRecords = records.map((record) => {
    const preferredCol = Math.max(0, Math.min(profile.cols - 1, Math.floor(record.position.x * profile.cols)));
    const preferredRow = Math.max(0, Math.min(profile.rows - 1, Math.floor(record.position.y * profile.rows)));
    const slot = nearestOpenSlot(preferredRow * profile.cols + preferredCol, occupied, profile);
    occupied.add(slot);

    return {
      id: record.id,
      slot,
      col: slot % profile.cols,
      row: Math.floor(slot / profile.cols),
      isLatest: record.id === latestRecordId,
    };
  });

  return {
    schemaVersion: 1,
    cols: profile.cols,
    rows: profile.rows,
    records: fieldRecords,
  };
}
