// Scoped AI flows for the layered editor: edit one layer, generate a new
// layer, or run every raster layer through i2i sequentially (the local worker
// is a single GPU — parallel submits would only queue anyway).

import { useCallback, useRef, useState } from 'react';
import { api } from '../../api/client';
import type { HistoryEntry, RasterLayer } from '../types';
import { useEditorStore } from '../editorStore';
import { adoptBitmap, bitmapFromImage, getBitmap } from '../bitmapRegistry';
import {
  applyAiResultPixels, bitmapHasAlpha, decodeBase64Image,
  rasterizeTextLayer, resampleToSize,
} from '../lib/compose';
import { JobCancelledError, pollJob } from '../lib/jobs';
import { saveEditorDocNow } from '../lib/persist';

export interface BatchLayerState {
  layerId: string;
  name: string;
  status: 'queued' | 'running' | 'done' | 'failed' | 'skipped';
  error?: string;
}

export interface BatchState {
  prompt: string;
  guidance: number;
  running: boolean;
  layers: BatchLayerState[];
}

const stripPrefix = (dataUrl: string) => dataUrl.replace(/^data:image\/png;base64,/, '');

function chatThumb(canvas: HTMLCanvasElement): string {
  const s = Math.min(1, 240 / Math.max(canvas.width, canvas.height));
  return resampleToSize(canvas, canvas.width * s, canvas.height * s).toDataURL('image/png');
}

export function useAiActions(projectId: number | null) {
  const [batch, setBatch] = useState<BatchState | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const patchBatchLayer = (layerId: string, patch: Partial<BatchLayerState>) => {
    setBatch((b) =>
      b ? { ...b, layers: b.layers.map((l) => (l.layerId === layerId ? { ...l, ...patch } : l)) } : b,
    );
  };

  /** i2i one layer's pixels through the given prompt. A text layer is
   *  rasterized only for the SUBMISSION — it's replaced by a raster layer
   *  solely on success, so a failed AI run leaves the editable text intact. */
  const editSingleLayer = useCallback(
    async (layerId: string, prompt: string, guidance: number): Promise<{ thumb: string; converted: boolean; name: string }> => {
      if (!projectId) throw new Error('No project.');
      const store = useEditorStore.getState();
      const layer = store.layers.find((l) => l.id === layerId);
      if (!layer) throw new Error('Layer not found.');
      if (layer.locked) throw new Error(`"${layer.name}" is locked.`);
      const isText = layer.type === 'text';
      const source = isText ? await rasterizeTextLayer(layer) : getBitmap(layer.id);
      if (!source) throw new Error('Layer bitmap missing.');
      useEditorStore.getState().setAiBusy(true);
      try {
        const { job_id } = await api.layerEdit(projectId, {
          prompt,
          image_b64: stripPrefix(source.toDataURL('image/png')),
          transparent: isText || bitmapHasAlpha(source),
          guidance_scale: guidance,
        });
        const result = await pollJob(job_id);
        if (isText) {
          // Success: swap the text layer for a raster layer holding the result
          // (one undoable batch — Ctrl+Z brings the editable text back).
          const img = await decodeBase64Image(result.images[0]);
          const pixels = resampleToSize(img, source.width, source.height);
          const raster: RasterLayer = {
            id: crypto.randomUUID(),
            type: 'raster',
            name: layer.name,
            visible: layer.visible,
            locked: layer.locked,
            opacity: layer.opacity,
            transform: { ...layer.transform },
            pixelWidth: pixels.width,
            pixelHeight: pixels.height,
          };
          adoptBitmap(raster.id, pixels);
          useEditorStore.getState().replaceLayer(layer.id, raster);
          void saveEditorDocNow();
          return { thumb: chatThumb(pixels), converted: true, name: layer.name };
        }
        const snaps = await applyAiResultPixels(layer.id, result.images[0]);
        if (snaps) useEditorStore.getState().commitBitmapChange(layer.id, snaps.before, snaps.after);
        void saveEditorDocNow();
        return { thumb: chatThumb(source), converted: false, name: layer.name };
      } finally {
        useEditorStore.getState().setAiBusy(false);
      }
    },
    [projectId],
  );

  /** t2i a brand-new layer (transparent background) centered on the document. */
  const generateNewLayer = useCallback(
    async (prompt: string): Promise<{ thumb: string; name: string }> => {
      if (!projectId) throw new Error('No project.');
      const store = useEditorStore.getState();
      const doc = store.doc;
      if (!doc) throw new Error('Editor not ready.');
      store.setAiBusy(true);
      try {
        const { job_id } = await api.layerGenerate(projectId, {
          prompt,
          width: Math.min(doc.width, 1024),
          height: Math.min(doc.height, 1024),
          transparent: true,
        });
        const result = await pollJob(job_id);
        const img = await decodeBase64Image(result.images[0]);
        const canvas = bitmapFromImage(img);
        const id = crypto.randomUUID();
        adoptBitmap(id, canvas);
        const name = prompt.length > 24 ? prompt.slice(0, 24).trimEnd() + '…' : prompt;
        const scale = Math.min(1, doc.width / canvas.width, doc.height / canvas.height);
        const layer: RasterLayer = {
          id,
          type: 'raster',
          name,
          visible: true,
          locked: false,
          opacity: 1,
          transform: { cx: doc.width / 2, cy: doc.height / 2, scaleX: scale, scaleY: scale, rotation: 0 },
          pixelWidth: canvas.width,
          pixelHeight: canvas.height,
        };
        useEditorStore.getState().addLayer(layer);
        void saveEditorDocNow();
        return { thumb: chatThumb(canvas), name };
      } finally {
        useEditorStore.getState().setAiBusy(false);
      }
    },
    [projectId],
  );

  /** Sequentially i2i every visible, unlocked RASTER layer (text layers are
   *  skipped — their content is usually meant literally). All results commit
   *  as ONE history batch, so a single undo reverts the whole run. */
  const editAllLayers = useCallback(
    async (prompt: string, guidance: number): Promise<{ done: number; failed: number; skipped: number }> => {
      if (!projectId) throw new Error('No project.');
      const store = useEditorStore.getState();
      const rows: BatchLayerState[] = store.layers.map((l) => ({
        layerId: l.id,
        name: l.name,
        status: l.type === 'raster' && l.visible && !l.locked ? 'queued' : 'skipped',
        error: l.type === 'text' ? 'Text layer — edit it directly or convert to paint.'
          : !l.visible ? 'Hidden.' : l.locked ? 'Locked.' : undefined,
      }));
      const targets = rows.filter((r) => r.status === 'queued').map((r) => r.layerId);
      if (!targets.length) throw new Error('No editable paint layers to run on.');

      const controller = new AbortController();
      abortRef.current = controller;
      setBatch({ prompt, guidance, running: true, layers: rows });
      store.setAiBusy(true);

      const entries: HistoryEntry[] = [];
      let done = 0;
      let failed = 0;
      try {
        for (const layerId of targets) {
          if (controller.signal.aborted) {
            patchBatchLayer(layerId, { status: 'skipped', error: 'Cancelled.' });
            continue;
          }
          const canvas = getBitmap(layerId);
          if (!canvas) {
            patchBatchLayer(layerId, { status: 'failed', error: 'Bitmap missing.' });
            failed++;
            continue;
          }
          patchBatchLayer(layerId, { status: 'running' });
          try {
            const { job_id } = await api.layerEdit(projectId, {
              prompt,
              image_b64: stripPrefix(canvas.toDataURL('image/png')),
              transparent: bitmapHasAlpha(canvas),
              guidance_scale: guidance,
            });
            const result = await pollJob(job_id, { signal: controller.signal });
            const snaps = await applyAiResultPixels(layerId, result.images[0]);
            if (snaps) entries.push({ kind: 'bitmap', layerId, before: snaps.before, after: snaps.after });
            patchBatchLayer(layerId, { status: 'done' });
            done++;
          } catch (err: any) {
            const cancelled = err instanceof JobCancelledError;
            patchBatchLayer(layerId, { status: cancelled ? 'skipped' : 'failed', error: err?.message || 'Failed.' });
            if (!cancelled) failed++;
          }
        }
      } finally {
        if (entries.length) useEditorStore.getState().commitBatch(entries);
        useEditorStore.getState().setAiBusy(false);
        setBatch((b) => (b ? { ...b, running: false } : b));
        abortRef.current = null;
        void saveEditorDocNow();
      }
      const skipped = rows.length - done - failed;
      return { done, failed, skipped };
    },
    [projectId],
  );

  /** Re-run one failed layer from the last batch (commits individually). */
  const retryBatchLayer = useCallback(
    async (layerId: string) => {
      const b = batch;
      if (!b || b.running || !projectId) return;
      patchBatchLayer(layerId, { status: 'running', error: undefined });
      try {
        await editSingleLayer(layerId, b.prompt, b.guidance);
        patchBatchLayer(layerId, { status: 'done' });
      } catch (err: any) {
        patchBatchLayer(layerId, { status: 'failed', error: err?.message || 'Failed.' });
      }
    },
    [batch, projectId, editSingleLayer],
  );

  const cancelBatch = useCallback(() => abortRef.current?.abort(), []);

  return { batch, editSingleLayer, generateNewLayer, editAllLayers, retryBatchLayer, cancelBatch };
}
