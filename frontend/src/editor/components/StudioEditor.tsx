import { useEffect, useRef, useState } from 'react';
import { api, type Generation, type Project } from '../../api/client';
import { Icon } from '../../components/Icon';
import type { SerializedDoc } from '../types';
import { useEditorStore } from '../editorStore';
import { hydrateSerializedDoc, seedDocFromGeneration, useAutosave } from '../lib/persist';
import { EditorViewport } from './EditorViewport';
import { Toolbox, ToolOptions } from './Toolbox';

// The left-pane editor: toolbox + options bar + stage. Owns document loading
// (server doc if it matches the chosen generation, else seeded fresh from the
// generation image), the keyboard shortcuts, and autosave.

export function StudioEditor({ project, chosen }: { project: Project; chosen: Generation }) {
  const doc = useEditorStore((s) => s.doc);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [retryTick, setRetryTick] = useState(0);
  const loadToken = useRef(0);

  useAutosave();

  useEffect(() => {
    const s = useEditorStore.getState();
    if (s.projectId === project.id && s.doc && s.doc.baseGenerationId === chosen.id) {
      setLoading(false);
      return;
    }
    const token = ++loadToken.current;
    setLoading(true);
    setLoadError('');
    (async () => {
      try {
        // Fetch failure here just means "no saved doc" — seeding is safe.
        let sd: SerializedDoc | null = null;
        try {
          sd = (await api.getEditorDoc(project.id)).document as SerializedDoc | null;
        } catch {
          sd = null;
        }
        let payload: Awaited<ReturnType<typeof seedDocFromGeneration>>;
        if (sd && sd.base_generation_id === chosen.id && Array.isArray(sd.layers) && sd.layers.length > 0) {
          // A saved layered doc exists. A hydrate failure (e.g. one bitmap
          // fetch hiccup) must NOT fall back to a flat reseed — the next
          // autosave would overwrite the saved doc and the server would
          // delete every layer bitmap as orphans. Surface a retry instead.
          payload = await hydrateSerializedDoc(sd);
          if (!payload.layers.length) payload = await seedDocFromGeneration(chosen); // doc truly empty
        } else {
          payload = await seedDocFromGeneration(chosen);
        }
        if (loadToken.current !== token) return;
        useEditorStore.getState().hydrate(project.id, payload.doc, payload.layers);
        setLoading(false);
      } catch (err: any) {
        if (loadToken.current !== token) return;
        setLoadError(err?.message || 'Failed to open the editor.');
        setLoading(false);
      }
    })();
  }, [project.id, chosen.id, retryTick]);

  // Leaving the studio tears the editor down (bitmaps included).
  useEffect(() => () => useEditorStore.getState().reset(), []);

  // Keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (/^(input|textarea|select)$/i.test(t.tagName) || t.isContentEditable)) return;
      const s = useEditorStore.getState();
      const mod = e.ctrlKey || e.metaKey;

      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) s.redo();
        else s.undo();
        return;
      }
      if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        s.redo();
        return;
      }
      if (mod) return;

      if (e.key === 'Delete' || e.key === 'Backspace') {
        const layer = s.layers.find((l) => l.id === s.selectedLayerId);
        if (layer && !layer.locked) {
          e.preventDefault();
          s.removeLayer(layer.id);
        }
        return;
      }
      if (e.key === 'Escape') {
        s.selectLayer(null);
        return;
      }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        const layer = s.layers.find((l) => l.id === s.selectedLayerId);
        if (!layer || layer.locked) return;
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
        s.updateLayer(layer.id, {
          transform: { ...layer.transform, cx: layer.transform.cx + dx, cy: layer.transform.cy + dy },
        });
        return;
      }
      const toolKeys: Record<string, Parameters<typeof s.setTool>[0]> = {
        v: 'select', b: 'brush', e: 'eraser', t: 'text',
      };
      const k = e.key.toLowerCase();
      if (toolKeys[k]) {
        s.setTool(toolKeys[k]);
        return;
      }
      if (k === '[' || k === ']') {
        const delta = k === '[' ? -2 : 2;
        if (s.tool === 'eraser') s.setEraser({ size: Math.max(2, Math.min(200, s.eraser.size + delta)) });
        else s.setBrush({ size: Math.max(1, Math.min(128, s.brush.size + delta)) });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (loading || !doc) {
    return (
      <div className="flex-1 flex items-center justify-center min-h-[240px]">
        {loadError ? (
          <div className="text-center text-on-surface-variant space-y-3">
            <Icon name="error" className="text-4xl text-error mb-2" />
            <p className="text-sm">{loadError}</p>
            <button
              onClick={() => setRetryTick((t) => t + 1)}
              className="px-5 py-2.5 rounded-xl font-headline font-bold text-sm bg-primary-container text-on-primary-container"
            >
              Try again
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-3 text-on-surface-variant">
            <div className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
            <span className="text-sm">Opening editor…</span>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col lg:flex-row min-h-0">
      <Toolbox />
      <div className="flex-1 flex flex-col min-h-0">
        <ToolOptions />
        <EditorViewport />
      </div>
    </div>
  );
}
