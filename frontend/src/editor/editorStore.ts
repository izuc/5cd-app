// Editor state store (zustand, same convention as store/authStore.ts).
// Cross-component state for the studio editor: document, layers, selection,
// active tool + options, undo/redo, and dirty tracking for autosave.
// Bitmap PIXELS are not here — see bitmapRegistry.ts.

import { create } from 'zustand';
import type { AiScope, EditorDoc, HistoryEntry, Layer, RectSnapshot, TextLayer, Tool } from './types';
import { trimHistory } from './lib/history';
import { createBitmap, ctx2d, disposeAllBitmaps, disposeBitmap, getBitmap } from './bitmapRegistry';
import { DEFAULT_FONT } from './lib/text';

interface EditorState {
  projectId: number | null;
  doc: EditorDoc | null;
  layers: Layer[]; // index 0 = bottom
  selectedLayerId: string | null;
  editingTextLayerId: string | null;
  /** A text layer being created but not yet committed to `layers` — it only
   *  joins the document (and history) when the user commits non-empty text. */
  editingTextDraft: TextLayer | null;
  tool: Tool;
  aiScope: AiScope;
  brush: { size: number; color: string; opacity: number };
  eraser: { size: number };
  shape: { stroke: string; fill: string | null; strokeWidth: number };
  textDefaults: Pick<TextLayer, 'fontFamily' | 'fontSize' | 'fontWeight' | 'italic' | 'color' | 'align' | 'lineHeight'>;
  bitmapRevs: Record<string, number>; // bumped on pixel changes → thumbnails re-render
  dirtyDoc: boolean;
  dirtyLayerIds: Set<string>;
  saveState: 'idle' | 'saving' | 'saved' | 'error';
  aiBusy: boolean;
  past: HistoryEntry[];
  future: HistoryEntry[];

  hydrate: (projectId: number, doc: EditorDoc, layers: Layer[]) => void;
  reset: () => void;
  setTool: (tool: Tool) => void;
  setAiScope: (scope: AiScope) => void;
  setBrush: (patch: Partial<EditorState['brush']>) => void;
  setEraser: (patch: Partial<EditorState['eraser']>) => void;
  setShape: (patch: Partial<EditorState['shape']>) => void;
  setTextDefaults: (patch: Partial<EditorState['textDefaults']>) => void;
  setAiBusy: (busy: boolean) => void;
  setSaveState: (s: EditorState['saveState']) => void;
  selectLayer: (id: string | null) => void;
  setEditingTextLayer: (id: string | null) => void;
  setEditingTextDraft: (layer: TextLayer | null) => void;
  /** Patch layer props. history:false for live drag frames; the gesture owner
   *  records one entry at the end via recordLayerProps. */
  updateLayer: (id: string, patch: Partial<Layer>, opts?: { history?: boolean; before?: Partial<Layer> }) => void;
  recordLayerProps: (id: string, before: Partial<Layer>, after: Partial<Layer>) => void;
  addLayer: (layer: Layer, index?: number) => void;
  removeLayer: (id: string) => void;
  /** Swap a layer for another in place (text -> raster conversion) as ONE
   *  undoable batch entry. The new layer's bitmap must already be registered. */
  replaceLayer: (oldId: string, newLayer: Layer) => void;
  duplicateLayer: (id: string) => void;
  reorderLayer: (id: string, dir: 1 | -1) => void;
  commitBitmapChange: (id: string, before: RectSnapshot, after: RectSnapshot) => void;
  bumpBitmapRev: (id: string) => void;
  commitBatch: (entries: HistoryEntry[]) => void;
  markLayerDirty: (id: string) => void;
  /** Clear dirty flags after a successful save. Only layers whose bitmap rev is
   *  unchanged since the save started are cleared (a stroke mid-save keeps the
   *  layer dirty); the doc flag clears only when the caller verified the doc
   *  JSON didn't change during the request. */
  markSaved: (saved: { id: string; rev: number }[], clearDocDirty: boolean) => void;
  setDirtyDoc: (dirty: boolean) => void;
  /** Re-point the doc at a new base generation (after a composite save) —
   *  layers stay as they are; only the lineage anchor moves. */
  setBaseGenerationId: (id: number) => void;
  /** Server-assigned bitmap URLs after a save round-trip. Not a user edit —
   *  no history, no dirty flags. */
  applyBitmapUrls: (urls: Record<string, string>) => void;
  undo: () => void;
  redo: () => void;
}

function pickProps(layer: Layer, keys: string[]): Partial<Layer> {
  const src = layer as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = src[k];
  return out as Partial<Layer>;
}

/** Apply one entry in the given direction; mutates registry bitmaps for pixel
 *  entries and returns the layers-array transformation. */
function applyEntry(
  layers: Layer[],
  entry: HistoryEntry,
  dir: 'undo' | 'redo',
  touched: { layerIds: Set<string>; structural: boolean },
): Layer[] {
  switch (entry.kind) {
    case 'layer-props': {
      const patch = dir === 'undo' ? entry.before : entry.after;
      touched.structural = true;
      return layers.map((l) => (l.id === entry.layerId ? ({ ...l, ...patch } as Layer) : l));
    }
    case 'reorder': {
      const from = dir === 'undo' ? entry.to : entry.from;
      const to = dir === 'undo' ? entry.from : entry.to;
      const idx = layers.findIndex((l) => l.id === entry.layerId);
      if (idx !== from) return layers; // stale entry; be safe
      const next = layers.slice();
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      touched.structural = true;
      return next;
    }
    case 'add-layer': {
      touched.structural = true;
      if (dir === 'undo') {
        disposeBitmap(entry.layer.id);
        return layers.filter((l) => l.id !== entry.layer.id);
      }
      const next = layers.slice();
      next.splice(Math.min(entry.index, next.length), 0, reinsertLayer(entry.layer, entry.bitmap, touched));
      return next;
    }
    case 'remove-layer': {
      touched.structural = true;
      if (dir === 'undo') {
        const next = layers.slice();
        next.splice(Math.min(entry.index, next.length), 0, reinsertLayer(entry.layer, entry.bitmap, touched));
        return next;
      }
      disposeBitmap(entry.layer.id);
      return layers.filter((l) => l.id !== entry.layer.id);
    }
    case 'bitmap': {
      const snap = dir === 'undo' ? entry.before : entry.after;
      const canvas = getBitmap(entry.layerId);
      if (canvas) ctx2d(canvas).putImageData(snap.data, snap.x, snap.y);
      touched.layerIds.add(entry.layerId);
      return layers;
    }
    case 'batch': {
      const list = dir === 'undo' ? entry.entries.slice().reverse() : entry.entries;
      let next = layers;
      for (const e of list) next = applyEntry(next, e, dir, touched);
      return next;
    }
  }
}

function restoreLayerBitmap(layer: Layer, bitmap?: ImageData) {
  if (layer.type !== 'raster') return;
  const canvas = getBitmap(layer.id) ?? createBitmap(layer.id, layer.pixelWidth, layer.pixelHeight);
  if (bitmap) ctx2d(canvas).putImageData(bitmap, 0, 0);
}

/** Re-insert a layer removed by undo/redo. The server may have deleted its
 *  bitmap file as an orphan in the meantime, so a raster layer comes back
 *  with its stale bitmapUrl STRIPPED and flagged for re-upload. */
function reinsertLayer(layer: Layer, bitmap: ImageData | undefined, touched: { layerIds: Set<string> }): Layer {
  restoreLayerBitmap(layer, bitmap);
  if (layer.type !== 'raster') return layer;
  touched.layerIds.add(layer.id);
  const { bitmapUrl, ...rest } = layer;
  void bitmapUrl;
  return rest;
}

function snapshotFullBitmap(layer: Layer): ImageData | undefined {
  if (layer.type !== 'raster') return undefined;
  const canvas = getBitmap(layer.id);
  if (!canvas) return undefined;
  return ctx2d(canvas).getImageData(0, 0, canvas.width, canvas.height);
}

const initialTools = {
  tool: 'select' as Tool,
  aiScope: 'image' as AiScope,
  brush: { size: 12, color: '#1e1e1e', opacity: 1 },
  eraser: { size: 24 },
  shape: { stroke: '#1e1e1e', fill: null as string | null, strokeWidth: 4 },
  textDefaults: {
    fontFamily: DEFAULT_FONT,
    fontSize: 48,
    fontWeight: 700 as const,
    italic: false,
    color: '#1e1e1e',
    align: 'left' as const,
    lineHeight: 1.25,
  },
};

export const useEditorStore = create<EditorState>()((set, get) => ({
  projectId: null,
  doc: null,
  layers: [],
  selectedLayerId: null,
  editingTextLayerId: null,
  editingTextDraft: null,
  ...initialTools,
  bitmapRevs: {},
  dirtyDoc: false,
  dirtyLayerIds: new Set<string>(),
  saveState: 'idle',
  aiBusy: false,
  past: [],
  future: [],

  hydrate: (projectId, doc, layers) =>
    set({
      projectId,
      doc,
      layers,
      selectedLayerId: null,
      editingTextLayerId: null,
      editingTextDraft: null,
      bitmapRevs: {},
      dirtyDoc: false,
      dirtyLayerIds: new Set(),
      saveState: 'idle',
      past: [],
      future: [],
    }),

  reset: () => {
    disposeAllBitmaps();
    set({
      projectId: null,
      doc: null,
      layers: [],
      selectedLayerId: null,
      editingTextLayerId: null,
      editingTextDraft: null,
      ...initialTools,
      bitmapRevs: {},
      dirtyDoc: false,
      dirtyLayerIds: new Set(),
      saveState: 'idle',
      aiBusy: false,
      past: [],
      future: [],
    });
  },

  setTool: (tool) => set({ tool }),
  setAiScope: (aiScope) => set({ aiScope }),
  setBrush: (patch) => set((s) => ({ brush: { ...s.brush, ...patch } })),
  setEraser: (patch) => set((s) => ({ eraser: { ...s.eraser, ...patch } })),
  setShape: (patch) => set((s) => ({ shape: { ...s.shape, ...patch } })),
  setTextDefaults: (patch) => set((s) => ({ textDefaults: { ...s.textDefaults, ...patch } })),
  setAiBusy: (aiBusy) => set({ aiBusy }),
  setSaveState: (saveState) => set({ saveState }),
  selectLayer: (id) => set({ selectedLayerId: id }),
  setEditingTextLayer: (id) => set({ editingTextLayerId: id }),
  setEditingTextDraft: (layer) => set({ editingTextDraft: layer }),

  updateLayer: (id, patch, opts) => {
    const s = get();
    const layer = s.layers.find((l) => l.id === id);
    if (!layer) return;
    const next: Partial<EditorState> = {
      layers: s.layers.map((l) => (l.id === id ? ({ ...l, ...patch } as Layer) : l)),
      dirtyDoc: true,
    };
    if (opts?.history !== false) {
      const before = opts?.before ?? pickProps(layer, Object.keys(patch));
      next.past = trimHistory([...s.past, { kind: 'layer-props', layerId: id, before, after: patch }]);
      next.future = [];
    }
    set(next);
  },

  recordLayerProps: (id, before, after) =>
    set((s) => ({
      past: trimHistory([...s.past, { kind: 'layer-props', layerId: id, before, after }]),
      future: [],
      dirtyDoc: true,
    })),

  addLayer: (layer, index) =>
    set((s) => {
      const next = s.layers.slice();
      const at = index === undefined ? next.length : Math.max(0, Math.min(index, next.length));
      next.splice(at, 0, layer);
      const dirty = new Set(s.dirtyLayerIds);
      if (layer.type === 'raster') dirty.add(layer.id);
      return {
        layers: next,
        selectedLayerId: layer.id,
        dirtyDoc: true,
        dirtyLayerIds: dirty,
        past: trimHistory([...s.past, { kind: 'add-layer', layer, index: at, bitmap: snapshotFullBitmap(layer) }]),
        future: [],
      };
    }),

  removeLayer: (id) => {
    const s = get();
    const index = s.layers.findIndex((l) => l.id === id);
    if (index < 0) return;
    const layer = s.layers[index];
    const entry: HistoryEntry = { kind: 'remove-layer', layer, index, bitmap: snapshotFullBitmap(layer) };
    disposeBitmap(id);
    const dirty = new Set(s.dirtyLayerIds);
    dirty.delete(id);
    set({
      layers: s.layers.filter((l) => l.id !== id),
      selectedLayerId: s.selectedLayerId === id ? null : s.selectedLayerId,
      editingTextLayerId: s.editingTextLayerId === id ? null : s.editingTextLayerId,
      dirtyDoc: true,
      dirtyLayerIds: dirty,
      past: trimHistory([...s.past, entry]),
      future: [],
    });
  },

  replaceLayer: (oldId, newLayer) => {
    const s = get();
    const index = s.layers.findIndex((l) => l.id === oldId);
    if (index < 0) return;
    const old = s.layers[index];
    const entries: HistoryEntry[] = [
      { kind: 'remove-layer', layer: old, index, bitmap: snapshotFullBitmap(old) },
      { kind: 'add-layer', layer: newLayer, index, bitmap: snapshotFullBitmap(newLayer) },
    ];
    disposeBitmap(oldId);
    const layers = s.layers.slice();
    layers[index] = newLayer;
    const dirty = new Set(s.dirtyLayerIds);
    dirty.delete(oldId);
    if (newLayer.type === 'raster') dirty.add(newLayer.id);
    set({
      layers,
      selectedLayerId: newLayer.id,
      editingTextLayerId: s.editingTextLayerId === oldId ? null : s.editingTextLayerId,
      dirtyDoc: true,
      dirtyLayerIds: dirty,
      past: trimHistory([...s.past, { kind: 'batch', entries }]),
      future: [],
    });
  },

  duplicateLayer: (id) => {
    const s = get();
    const index = s.layers.findIndex((l) => l.id === id);
    if (index < 0) return;
    const src = s.layers[index];
    const copy: Layer = {
      ...src,
      id: crypto.randomUUID(),
      name: `${src.name} copy`,
      transform: { ...src.transform, cx: src.transform.cx + 16, cy: src.transform.cy + 16 },
    };
    if (copy.type === 'raster') delete copy.bitmapUrl;
    if (src.type === 'raster') {
      const srcCanvas = getBitmap(src.id);
      const canvas = createBitmap(copy.id, src.pixelWidth, src.pixelHeight);
      if (srcCanvas) ctx2d(canvas).drawImage(srcCanvas, 0, 0);
    }
    get().addLayer(copy, index + 1);
  },

  reorderLayer: (id, dir) => {
    const s = get();
    const from = s.layers.findIndex((l) => l.id === id);
    const to = from + dir;
    if (from < 0 || to < 0 || to >= s.layers.length) return;
    const next = s.layers.slice();
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    set({
      layers: next,
      dirtyDoc: true,
      past: trimHistory([...s.past, { kind: 'reorder', layerId: id, from, to }]),
      future: [],
    });
  },

  commitBitmapChange: (id, before, after) =>
    set((s) => {
      const dirty = new Set(s.dirtyLayerIds);
      dirty.add(id);
      return {
        past: trimHistory([...s.past, { kind: 'bitmap', layerId: id, before, after }]),
        future: [],
        dirtyDoc: true,
        dirtyLayerIds: dirty,
        bitmapRevs: { ...s.bitmapRevs, [id]: (s.bitmapRevs[id] || 0) + 1 },
      };
    }),

  bumpBitmapRev: (id) =>
    set((s) => ({ bitmapRevs: { ...s.bitmapRevs, [id]: (s.bitmapRevs[id] || 0) + 1 } })),

  commitBatch: (entries) => {
    if (!entries.length) return;
    set((s) => {
      const dirty = new Set(s.dirtyLayerIds);
      const revs = { ...s.bitmapRevs };
      const collect = (list: HistoryEntry[]) => {
        for (const e of list) {
          if (e.kind === 'bitmap') {
            dirty.add(e.layerId);
            revs[e.layerId] = (revs[e.layerId] || 0) + 1;
          } else if (e.kind === 'batch') collect(e.entries);
        }
      };
      collect(entries);
      return {
        past: trimHistory([...s.past, { kind: 'batch', entries }]),
        future: [],
        dirtyDoc: true,
        dirtyLayerIds: dirty,
        bitmapRevs: revs,
      };
    });
  },

  markLayerDirty: (id) =>
    set((s) => {
      const dirty = new Set(s.dirtyLayerIds);
      dirty.add(id);
      return { dirtyLayerIds: dirty, dirtyDoc: true };
    }),

  markSaved: (saved, clearDocDirty) =>
    set((s) => {
      const dirty = new Set(s.dirtyLayerIds);
      for (const { id, rev } of saved) {
        if ((s.bitmapRevs[id] || 0) === rev) dirty.delete(id);
      }
      return {
        dirtyLayerIds: dirty,
        dirtyDoc: clearDocDirty && dirty.size === 0 ? false : s.dirtyDoc,
        saveState: 'saved',
      };
    }),

  setDirtyDoc: (dirtyDoc) => set({ dirtyDoc }),

  setBaseGenerationId: (id) =>
    set((s) => (s.doc ? { doc: { ...s.doc, baseGenerationId: id }, dirtyDoc: true } : s)),

  applyBitmapUrls: (urls) =>
    set((s) => ({
      layers: s.layers.map((l) =>
        l.type === 'raster' && urls[l.id] ? { ...l, bitmapUrl: urls[l.id] } : l,
      ),
    })),

  undo: () => {
    const s = get();
    const entry = s.past[s.past.length - 1];
    if (!entry) return;
    const touched = { layerIds: new Set<string>(), structural: false };
    const layers = applyEntry(s.layers, entry, 'undo', touched);
    const revs = { ...s.bitmapRevs };
    // Prune dirty ids for layers that no longer exist (an undone add-layer
    // would otherwise leave a ghost id that keeps autosave firing forever).
    const dirty = new Set([...s.dirtyLayerIds].filter((id) => layers.some((l) => l.id === id)));
    for (const id of touched.layerIds) {
      revs[id] = (revs[id] || 0) + 1;
      if (layers.some((l) => l.id === id)) dirty.add(id);
    }
    set({
      layers,
      past: s.past.slice(0, -1),
      future: [...s.future, entry],
      bitmapRevs: revs,
      dirtyLayerIds: dirty,
      dirtyDoc: true,
      selectedLayerId: s.selectedLayerId && layers.some((l) => l.id === s.selectedLayerId) ? s.selectedLayerId : null,
    });
  },

  redo: () => {
    const s = get();
    const entry = s.future[s.future.length - 1];
    if (!entry) return;
    const touched = { layerIds: new Set<string>(), structural: false };
    const layers = applyEntry(s.layers, entry, 'redo', touched);
    const revs = { ...s.bitmapRevs };
    const dirty = new Set([...s.dirtyLayerIds].filter((id) => layers.some((l) => l.id === id)));
    for (const id of touched.layerIds) {
      revs[id] = (revs[id] || 0) + 1;
      if (layers.some((l) => l.id === id)) dirty.add(id);
    }
    set({
      layers,
      past: [...s.past, entry],
      future: s.future.slice(0, -1),
      bitmapRevs: revs,
      dirtyLayerIds: dirty,
      dirtyDoc: true,
      selectedLayerId: s.selectedLayerId && layers.some((l) => l.id === s.selectedLayerId) ? s.selectedLayerId : null,
    });
  },
}));

// Dev-only escape hatch for debugging/automation (puppeteer verification).
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__editorStore = useEditorStore;
}
