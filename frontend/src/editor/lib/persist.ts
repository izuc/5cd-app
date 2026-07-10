// Document persistence: seeding from a generation, (de)serialization to the
// server wire shape, and debounced autosave.

import { useEffect } from 'react';
import { api, type Generation } from '../../api/client';
import type { EditorDoc, Layer, RasterLayer, SerializedDoc, SerializedLayer } from '../types';
import { adoptBitmap, bitmapFromImage, bitmapToBase64Png } from '../bitmapRegistry';
import { useEditorStore } from '../editorStore';
import { loadImageEl } from './compose';

/** Build a fresh single-layer document from a generation. The base image is
 *  COPIED into a layer bitmap — generation files are deleted on regenerate, so
 *  the doc must never reference generation_*.png as a pixel source. */
export async function seedDocFromGeneration(gen: Generation): Promise<{ doc: EditorDoc; layers: Layer[] }> {
  const img = await loadImageEl(gen.output_image_url + '?t=' + gen.id);
  const w = img.naturalWidth || gen.width || 1024;
  const h = img.naturalHeight || gen.height || 1024;
  const id = crypto.randomUUID();
  adoptBitmap(id, bitmapFromImage(img));
  const layer: RasterLayer = {
    id,
    type: 'raster',
    name: 'Background',
    visible: true,
    locked: false,
    opacity: 1,
    transform: { cx: w / 2, cy: h / 2, scaleX: 1, scaleY: 1, rotation: 0 },
    pixelWidth: w,
    pixelHeight: h,
  };
  return {
    doc: { version: 1, width: w, height: h, baseGenerationId: gen.id },
    layers: [layer],
  };
}

export function serializeDoc(doc: EditorDoc, layers: Layer[]): SerializedDoc {
  return {
    version: 1,
    width: doc.width,
    height: doc.height,
    base_generation_id: doc.baseGenerationId,
    layers: layers.map((l): SerializedLayer => {
      if (l.type === 'raster') {
        const { bitmapUrl, ...rest } = l;
        return { ...rest, ...(bitmapUrl ? { bitmap_url: bitmapUrl } : {}) };
      }
      return { ...l };
    }),
  };
}

/** Rebuild doc + layers from the server document, fetching raster bitmaps. */
export async function hydrateSerializedDoc(sd: SerializedDoc): Promise<{ doc: EditorDoc; layers: Layer[] }> {
  const layers: Layer[] = [];
  for (const sl of sd.layers) {
    if (sl.type === 'raster') {
      const layer: RasterLayer = {
        id: sl.id,
        type: 'raster',
        name: sl.name,
        visible: sl.visible,
        locked: sl.locked,
        opacity: sl.opacity,
        transform: sl.transform,
        pixelWidth: sl.pixelWidth,
        pixelHeight: sl.pixelHeight,
        bitmapUrl: sl.bitmap_url,
      };
      if (sl.bitmap_url) {
        const img = await loadImageEl(sl.bitmap_url + '?t=' + Date.now());
        layer.pixelWidth = img.naturalWidth || sl.pixelWidth;
        layer.pixelHeight = img.naturalHeight || sl.pixelHeight;
        adoptBitmap(sl.id, bitmapFromImage(img));
      } else {
        // A raster layer without a server bitmap can't be restored — skip it.
        continue;
      }
      layers.push(layer);
    } else {
      layers.push({ ...sl });
    }
  }
  return {
    doc: { version: 1, width: sd.width, height: sd.height, baseGenerationId: sd.base_generation_id },
    layers,
  };
}

// ---------------------------------------------------------------------------
// Autosave. Module-level state so the debounce survives StrictMode double
// mounts and AI flows can flush a save imperatively.

const AUTOSAVE_DEBOUNCE_MS = 2000;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let saving = false;
let queued = false;

/** Persist the doc + dirty layer bitmaps right now. Safe to call anytime. */
export async function saveEditorDocNow(): Promise<void> {
  const s = useEditorStore.getState();
  if (!s.projectId || !s.doc) return;
  if (!s.dirtyDoc && s.dirtyLayerIds.size === 0) return;
  if (saving) {
    queued = true;
    return;
  }
  saving = true;
  s.setSaveState('saving');
  try {
    const docJson = serializeDoc(s.doc, s.layers);
    const snapshot = JSON.stringify(docJson);
    // Upload every raster layer that's flagged dirty PLUS any that has no
    // server bitmap yet (seeded/re-added layers) — a raster layer saved
    // without a bitmap_url would be silently dropped on the next hydrate.
    const dirtySet = new Set(s.dirtyLayerIds);
    for (const l of s.layers) {
      if (l.type === 'raster' && !l.bitmapUrl) dirtySet.add(l.id);
    }
    const dirtyIds = [...dirtySet].filter((id) =>
      s.layers.some((l) => l.id === id && l.type === 'raster'),
    );
    const revs = dirtyIds.map((id) => ({ id, rev: s.bitmapRevs[id] || 0 }));
    const bitmaps: Record<string, string> = {};
    for (const id of dirtyIds) {
      const b64 = bitmapToBase64Png(id);
      if (b64) bitmaps[id] = b64;
    }
    const res = await api.saveEditorDoc(s.projectId, docJson, bitmaps);
    const after = useEditorStore.getState();
    if (after.projectId !== s.projectId) return; // project switched mid-save
    // Did the user edit while the request was in flight? (URL rewrites from
    // the server aren't user edits — compare before applying them.)
    const unchanged = after.doc
      ? JSON.stringify(serializeDoc(after.doc, after.layers)) === snapshot
      : false;
    const urls: Record<string, string> = {};
    for (const sl of (res.document?.layers ?? []) as SerializedLayer[]) {
      if (sl.type === 'raster' && sl.bitmap_url) urls[sl.id] = sl.bitmap_url;
    }
    after.applyBitmapUrls(urls);
    after.markSaved(revs, unchanged);
  } catch {
    useEditorStore.getState().setSaveState('error');
  } finally {
    saving = false;
    if (queued) {
      queued = false;
      scheduleSave();
    }
  }
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void saveEditorDocNow();
  }, AUTOSAVE_DEBOUNCE_MS);
}

/** Debounced autosave: schedules a save whenever the doc dirties (paused
 *  while an AI batch runs), and flushes when the tab is hidden. */
export function useAutosave() {
  useEffect(() => {
    const unsub = useEditorStore.subscribe((state) => {
      if (state.aiBusy) return;
      if (state.dirtyDoc || state.dirtyLayerIds.size > 0) scheduleSave();
    });
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        if (saveTimer) {
          clearTimeout(saveTimer);
          saveTimer = null;
        }
        void saveEditorDocNow();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      unsub();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);
}
