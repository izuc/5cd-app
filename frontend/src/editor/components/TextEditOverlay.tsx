import { useEffect, useMemo, useRef } from 'react';
import type { Point, TextLayer } from '../types';
import { useEditorStore } from '../editorStore';
import { getIntrinsicSize, layerToDoc, measureAndPatch } from '../lib/transform';
import { ensureFontLoaded } from '../lib/text';

// Inline text editing: a contentEditable div rendered with the exact same
// transform + typography as the layer. Anchored at the layer's TOP-LEFT so the
// box grows right/down while typing instead of re-centering every keystroke;
// commit converts the top-left anchor back into a center transform.
//
// Commit: blur, Ctrl+Enter, or clicking anywhere else. Escape cancels (a new
// draft is discarded entirely — it never entered the document or history).

interface Camera {
  zoom: number;
  panX: number;
  panY: number;
}

export function TextEditOverlay({ camera }: { camera: Camera }) {
  const draft = useEditorStore((s) => s.editingTextDraft);
  const existingId = useEditorStore((s) => s.editingTextLayerId);
  const existing = useEditorStore((s) =>
    s.editingTextLayerId ? s.layers.find((l) => l.id === s.editingTextLayerId) ?? null : null,
  );
  const layer = (existing?.type === 'text' ? existing : null) ?? draft;

  const editRef = useRef<HTMLDivElement>(null);
  const committed = useRef(false);
  // The top-left anchor is captured once per edit session so typing/styling
  // never shifts the text's origin under the caret.
  const anchor = useRef<Point | null>(null);
  const sessionKey = existingId ?? draft?.id ?? '';
  useEffect(() => {
    anchor.current = null;
    committed.current = false;
  }, [sessionKey]);

  const anchorDoc = useMemo<Point | null>(() => {
    if (!layer) return null;
    if (!anchor.current) {
      const size = getIntrinsicSize(layer);
      anchor.current = layerToDoc({ x: 0, y: 0 }, layer.transform, size);
    }
    return anchor.current;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layer?.id]);

  useEffect(() => {
    if (!layer) return;
    ensureFontLoaded(layer);
    const el = editRef.current;
    if (!el) return;
    el.innerText = layer.text;
    // Focus on the next frame: this effect can flush DURING the pointerdown
    // that created the draft, and the browser's default mousedown focus action
    // (which runs after dispatch) would immediately blur us -> empty commit.
    const raf = requestAnimationFrame(() => {
      el.focus();
      // Caret to the end.
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionKey]);

  if (!layer || !anchorDoc) return null;

  const commit = () => {
    if (committed.current) return;
    committed.current = true;
    const s = useEditorStore.getState();
    const text = (editRef.current?.innerText ?? '').replace(/\n$/, '');
    const done = () => {
      s.setEditingTextLayer(null);
      s.setEditingTextDraft(null);
    };
    if (!text.trim()) {
      // Empty result: discard a draft, delete an existing layer.
      if (existing) s.removeLayer(existing.id);
      done();
      return;
    }
    const finalLayer: TextLayer = { ...layer, text };
    const patched = measureAndPatch(finalLayer, anchorDoc);
    if (draft && !existing) {
      s.addLayer(patched);
    } else if (existing && existing.type === 'text') {
      if (existing.text !== text) {
        s.updateLayer(existing.id, { text: patched.text, transform: patched.transform }, {
          before: { text: existing.text, transform: existing.transform },
        });
      }
    }
    done();
  };

  const cancel = () => {
    if (committed.current) return;
    committed.current = true;
    const s = useEditorStore.getState();
    s.setEditingTextLayer(null);
    s.setEditingTextDraft(null);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      commit();
    }
  };

  const t = layer.transform;
  return (
    <div
      className="absolute"
      style={{
        left: 0,
        top: 0,
        transform: `translate(${camera.panX}px, ${camera.panY}px) scale(${camera.zoom})`,
        transformOrigin: '0 0',
      }}
    >
      <div
        ref={editRef}
        contentEditable="plaintext-only"
        suppressContentEditableWarning
        role="textbox"
        aria-label="Edit text layer"
        onKeyDown={onKeyDown}
        onBlur={commit}
        onPointerDown={(e) => e.stopPropagation()}
        style={{
          position: 'absolute',
          left: anchorDoc.x,
          top: anchorDoc.y,
          transform: `rotate(${t.rotation}deg) scale(${t.scaleX}, ${t.scaleY})`,
          transformOrigin: '0 0',
          minWidth: '1ch',
          width: 'max-content',
          whiteSpace: 'pre',
          outline: `${2 / camera.zoom}px dashed var(--color-primary)`,
          outlineOffset: 2 / camera.zoom,
          fontFamily: `"${layer.fontFamily}"`,
          fontSize: layer.fontSize,
          fontWeight: layer.fontWeight,
          fontStyle: layer.italic ? 'italic' : 'normal',
          color: layer.color,
          textAlign: layer.align,
          lineHeight: layer.lineHeight,
          caretColor: 'var(--color-primary)',
          cursor: 'text',
        }}
      />
    </div>
  );
}
