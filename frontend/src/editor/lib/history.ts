// Undo/redo helpers. Entries are commands with enough data to invert them;
// raster changes carry dirty-rect ImageData so strokes don't snapshot whole
// frames. The stack is budgeted by entry count AND bitmap bytes (an AI edit of
// a large layer stores two full-layer snapshots).

import type { HistoryEntry, RectSnapshot } from '../types';

export const MAX_ENTRIES = 50;
export const MAX_BITMAP_BYTES = 48 * 1024 * 1024;

function snapshotBytes(s?: RectSnapshot | ImageData): number {
  if (!s) return 0;
  const data = 'data' in s && s.data instanceof ImageData ? s.data : (s as ImageData);
  return data.data?.byteLength ?? 0;
}

export function entryBytes(entry: HistoryEntry): number {
  switch (entry.kind) {
    case 'bitmap':
      return snapshotBytes(entry.before) + snapshotBytes(entry.after);
    case 'add-layer':
    case 'remove-layer':
      return entry.bitmap ? entry.bitmap.data.byteLength : 0;
    case 'batch':
      return entry.entries.reduce((sum, e) => sum + entryBytes(e), 0);
    default:
      return 0;
  }
}

/** Trim from the oldest end until both budgets hold. */
export function trimHistory(past: HistoryEntry[]): HistoryEntry[] {
  let out = past.length > MAX_ENTRIES ? past.slice(past.length - MAX_ENTRIES) : past;
  let bytes = out.reduce((sum, e) => sum + entryBytes(e), 0);
  let drop = 0;
  while (bytes > MAX_BITMAP_BYTES && drop < out.length - 1) {
    bytes -= entryBytes(out[drop]);
    drop++;
  }
  return drop > 0 ? out.slice(drop) : out;
}
