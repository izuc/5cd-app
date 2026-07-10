import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '../../components/Icon';
import type { Layer, Point, RasterLayer, TextLayer, Transform } from '../types';
import { useEditorStore } from '../editorStore';
import { LayerView } from './LayerView';
import { SelectionOverlay } from './SelectionOverlay';
import { TextEditOverlay } from './TextEditOverlay';
import { hitTestLayers } from '../lib/transform';
import { StrokeSession, type StrokeMode } from '../lib/strokes';
import { renderLayerToCtx } from '../lib/compose';
import { ctx2d } from '../bitmapRegistry';

// The editor stage: a document-sized div CSS-scaled by the camera, layers
// stacked inside in array order (bottom -> top = DOM order). Gesture handling
// (pan/pinch/zoom, select/move, paint, text placement) follows the pointer
// patterns proven in SvgVectorEditor.tsx.

interface Camera {
  zoom: number;
  panX: number;
  panY: number;
}

type Gesture =
  | { type: 'pan'; start: Point; startCam: Camera }
  | { type: 'pinch'; startDist: number; startZoom: number; midDoc: Point }
  | { type: 'maybe-move'; layerId: string; startScreen: Point; startTransform: Transform }
  | { type: 'move'; layerId: string; startScreen: Point; startTransform: Transform }
  | { type: 'stroke'; session: StrokeSession; layerId: string };

const ZOOM_MIN = 0.05;
const ZOOM_MAX = 32;
const STROKE_MODES: StrokeMode[] = ['brush', 'eraser', 'line', 'rect', 'ellipse'];

export function EditorViewport() {
  const doc = useEditorStore((s) => s.doc);
  const layers = useEditorStore((s) => s.layers);
  const tool = useEditorStore((s) => s.tool);
  const brush = useEditorStore((s) => s.brush);
  const eraser = useEditorStore((s) => s.eraser);
  const shape = useEditorStore((s) => s.shape);
  const editingTextLayerId = useEditorStore((s) => s.editingTextLayerId);
  const editingTextDraft = useEditorStore((s) => s.editingTextDraft);
  const textEditing = !!(editingTextLayerId || editingTextDraft);

  const [camera, setCamera] = useState<Camera | null>(null);
  const [hint, setHint] = useState('');
  const cameraRef = useRef<Camera | null>(null);
  cameraRef.current = camera;
  const viewportRef = useRef<HTMLDivElement>(null);
  const ptrs = useRef(new Map<number, Point>());
  const gesture = useRef<Gesture | null>(null);
  const moved = useRef(false);
  const spaceDown = useRef(false);
  const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showHint = useCallback((msg: string) => {
    setHint(msg);
    if (hintTimer.current) clearTimeout(hintTimer.current);
    hintTimer.current = setTimeout(() => setHint(''), 2600);
  }, []);

  const clampCamera = useCallback((cam: Camera): Camera => {
    const el = viewportRef.current;
    const d = useEditorStore.getState().doc;
    if (!el || !d) return cam;
    const vw = el.clientWidth;
    const vh = el.clientHeight;
    const zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, cam.zoom));
    // Keep the document overlapping the viewport (>= ~15% from each edge).
    const panX = Math.min(vw * 0.85, Math.max(vw * 0.15 - d.width * zoom, cam.panX));
    const panY = Math.min(vh * 0.85, Math.max(vh * 0.15 - d.height * zoom, cam.panY));
    return { zoom, panX, panY };
  }, []);

  const fitCamera = useCallback((): Camera | null => {
    const el = viewportRef.current;
    const d = useEditorStore.getState().doc;
    if (!el || !d || !el.clientWidth || !el.clientHeight) return null;
    const zoom = Math.min(1, (el.clientWidth * 0.94) / d.width, (el.clientHeight * 0.94) / d.height);
    return {
      zoom,
      panX: (el.clientWidth - d.width * zoom) / 2,
      panY: (el.clientHeight - d.height * zoom) / 2,
    };
  }, []);

  // Initial fit (and refit when the document size changes -> camera reset below).
  const docKey = doc ? `${doc.width}x${doc.height}` : '';
  useEffect(() => {
    setCamera(null);
  }, [docKey]);
  useEffect(() => {
    if (camera || !doc) return;
    const el = viewportRef.current;
    if (!el) return;
    const tryFit = () => {
      const cam = fitCamera();
      if (cam) setCamera(cam);
    };
    tryFit();
    const ro = new ResizeObserver(() => {
      if (!cameraRef.current) tryFit();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [camera, doc, fitCamera]);

  const screenToDoc = useCallback((clientX: number, clientY: number): Point => {
    const el = viewportRef.current;
    const cam = cameraRef.current;
    if (!el || !cam) return { x: 0, y: 0 };
    const r = el.getBoundingClientRect();
    return {
      x: (clientX - r.left - cam.panX) / cam.zoom,
      y: (clientY - r.top - cam.panY) / cam.zoom,
    };
  }, []);

  const docToScreen = useCallback(
    (pt: Point): Point => {
      const cam = camera;
      if (!cam) return { x: 0, y: 0 };
      return { x: pt.x * cam.zoom + cam.panX, y: pt.y * cam.zoom + cam.panY };
    },
    [camera],
  );

  const zoomAt = useCallback(
    (clientX: number, clientY: number, factor: number) => {
      const el = viewportRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setCamera((prev) => {
        if (!prev) return prev;
        const zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, prev.zoom * factor));
        const dx = clientX - r.left;
        const dy = clientY - r.top;
        const docX = (dx - prev.panX) / prev.zoom;
        const docY = (dy - prev.panY) / prev.zoom;
        return clampCamera({ zoom, panX: dx - docX * zoom, panY: dy - docY * zoom });
      });
    },
    [clampCamera],
  );

  const zoomCenter = (factor: number) => {
    const el = viewportRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    zoomAt(r.left + r.width / 2, r.top + r.height / 2, factor);
  };

  // Wheel zoom needs a native non-passive listener (React's delegated wheel
  // listener is passive, so preventDefault there can't stop the page scroll).
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.15 : 1 / 1.15);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomAt]);

  // Space-held temporary pan.
  useEffect(() => {
    const isTyping = (t: EventTarget | null) => {
      const el = t as HTMLElement | null;
      return !!el && (/^(input|textarea|select)$/i.test(el.tagName) || el.isContentEditable);
    };
    const down = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !isTyping(e.target)) {
        spaceDown.current = true;
        e.preventDefault();
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') spaceDown.current = false;
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  const capture = (el: Element | null, pointerId: number) => {
    try { el?.setPointerCapture(pointerId); } catch { /* pointer already gone */ }
  };

  /** The raster layer paint gestures should target: the selection if it's a
   *  usable raster layer, else the topmost visible unlocked raster layer. */
  const paintTarget = (): RasterLayer | null => {
    const s = useEditorStore.getState();
    const sel = s.layers.find((l) => l.id === s.selectedLayerId);
    if (sel && sel.type === 'raster' && sel.visible && !sel.locked) return sel;
    if (sel) return null; // selected but not paintable — let the caller hint
    for (let i = s.layers.length - 1; i >= 0; i--) {
      const l = s.layers[i];
      if (l.type === 'raster' && l.visible && !l.locked) return l;
    }
    return null;
  };

  const sampleColorAt = (docPt: Point): string | null => {
    const s = useEditorStore.getState();
    if (!s.doc) return null;
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const ctx = ctx2d(canvas);
    ctx.translate(-docPt.x, -docPt.y);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(docPt.x, docPt.y, 1, 1);
    for (const layer of s.layers) {
      if (layer.visible) renderLayerToCtx(ctx, layer);
    }
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    const s = useEditorStore.getState();
    if (!s.doc || !cameraRef.current) return;
    if (textEditing) return; // text overlay owns input; this click just commits it (via blur)
    ptrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    moved.current = false;

    if (ptrs.current.size === 2) {
      // Pinch zoom takes over any other gesture.
      const g = gesture.current;
      if (g?.type === 'stroke') g.session.cancel();
      if (g?.type === 'move' || g?.type === 'maybe-move') {
        s.updateLayer(g.layerId, { transform: g.startTransform }, { history: false });
      }
      const [a, b] = [...ptrs.current.values()];
      gesture.current = {
        type: 'pinch',
        startDist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        startZoom: cameraRef.current.zoom,
        midDoc: screenToDoc((a.x + b.x) / 2, (a.y + b.y) / 2),
      };
      capture(e.currentTarget as Element, e.pointerId);
      return;
    }

    const docPt = screenToDoc(e.clientX, e.clientY);

    if (e.button === 1 || tool === 'pan' || spaceDown.current) {
      gesture.current = { type: 'pan', start: { x: e.clientX, y: e.clientY }, startCam: { ...cameraRef.current } };
      capture(e.currentTarget as Element, e.pointerId);
      return;
    }
    if (e.button !== 0) return;

    if (tool === 'select') {
      const hitLayer = hitTestLayers(docPt, s.layers);
      if (hitLayer) {
        if (s.selectedLayerId !== hitLayer.id) s.selectLayer(hitLayer.id);
        gesture.current = {
          type: 'maybe-move',
          layerId: hitLayer.id,
          startScreen: { x: e.clientX, y: e.clientY },
          startTransform: { ...hitLayer.transform },
        };
        capture(e.currentTarget as Element, e.pointerId);
      }
      return;
    }

    if (STROKE_MODES.includes(tool as StrokeMode)) {
      const target = paintTarget();
      if (!target) {
        showHint('Select a paint layer to draw on — text layers can’t be painted.');
        return;
      }
      if (s.selectedLayerId !== target.id) s.selectLayer(target.id);
      const mode = tool as StrokeMode;
      try {
        const session = new StrokeSession(target, {
          mode,
          color: mode === 'brush' ? brush.color : shape.stroke,
          size: mode === 'brush' ? brush.size : mode === 'eraser' ? eraser.size : shape.strokeWidth,
          opacity: mode === 'brush' ? brush.opacity : 1,
          fill: mode === 'rect' || mode === 'ellipse' ? shape.fill : null,
        });
        session.addPointerEvent(e.nativeEvent, screenToDoc, e.shiftKey);
        gesture.current = { type: 'stroke', session, layerId: target.id };
        capture(e.currentTarget as Element, e.pointerId);
      } catch {
        /* bitmap missing — ignore */
      }
      return;
    }

    if (tool === 'text') {
      // Prevent the mousedown default focus action: it would fire AFTER the
      // overlay mounts + focuses (React flushes discrete-event effects first)
      // and blur-commit the empty draft instantly.
      e.preventDefault();
      // Draft only — the layer joins the document when non-empty text commits.
      s.setEditingTextDraft(makeTextLayer(s.textDefaults, docPt));
      s.setTool('select');
      return;
    }

    if (tool === 'picker') {
      const hex = sampleColorAt(docPt);
      if (hex) {
        s.setBrush({ color: hex });
        s.setShape({ stroke: hex });
        showHint(`Picked ${hex}`);
      }
      return;
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (ptrs.current.has(e.pointerId)) ptrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    if (!g) return;
    const s = useEditorStore.getState();

    if (g.type === 'pinch' && ptrs.current.size >= 2) {
      const [a, b] = [...ptrs.current.values()];
      const el = viewportRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, g.startZoom * (dist / g.startDist)));
      const midX = (a.x + b.x) / 2 - r.left;
      const midY = (a.y + b.y) / 2 - r.top;
      setCamera(clampCamera({ zoom, panX: midX - g.midDoc.x * zoom, panY: midY - g.midDoc.y * zoom }));
      moved.current = true;
      return;
    }
    if (g.type === 'pan') {
      setCamera(clampCamera({
        ...g.startCam,
        panX: g.startCam.panX + (e.clientX - g.start.x),
        panY: g.startCam.panY + (e.clientY - g.start.y),
      }));
      if (Math.hypot(e.clientX - g.start.x, e.clientY - g.start.y) > 3) moved.current = true;
      return;
    }
    if (g.type === 'maybe-move') {
      if (Math.hypot(e.clientX - g.startScreen.x, e.clientY - g.startScreen.y) > 4) {
        gesture.current = { type: 'move', layerId: g.layerId, startScreen: g.startScreen, startTransform: g.startTransform };
        moved.current = true;
      }
      return;
    }
    if (g.type === 'move') {
      const cam = cameraRef.current;
      if (!cam) return;
      const layer = s.layers.find((l) => l.id === g.layerId);
      if (!layer || layer.locked) return;
      const dx = (e.clientX - g.startScreen.x) / cam.zoom;
      const dy = (e.clientY - g.startScreen.y) / cam.zoom;
      s.updateLayer(
        g.layerId,
        { transform: { ...g.startTransform, cx: g.startTransform.cx + dx, cy: g.startTransform.cy + dy } },
        { history: false },
      );
      moved.current = true;
      return;
    }
    if (g.type === 'stroke') {
      g.session.addPointerEvent(e.nativeEvent, screenToDoc, e.shiftKey);
      moved.current = true;
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    ptrs.current.delete(e.pointerId);
    const g = gesture.current;
    const s = useEditorStore.getState();

    if (g?.type === 'pinch') {
      if (ptrs.current.size < 2) gesture.current = null;
      return;
    }
    if (g?.type === 'pan') {
      gesture.current = null;
      return;
    }
    if (g?.type === 'maybe-move') {
      gesture.current = null;
      return;
    }
    if (g?.type === 'move') {
      gesture.current = null;
      const cur = s.layers.find((l) => l.id === g.layerId);
      if (cur && (cur.transform.cx !== g.startTransform.cx || cur.transform.cy !== g.startTransform.cy)) {
        s.recordLayerProps(g.layerId, { transform: g.startTransform }, { transform: cur.transform });
      }
      return;
    }
    if (g?.type === 'stroke') {
      gesture.current = null;
      const result = g.session.commit();
      if (result) s.commitBitmapChange(g.layerId, result.before, result.after);
      return;
    }

    // Click on empty space with select tool deselects.
    if (tool === 'select' && !moved.current) s.selectLayer(null);
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    if (tool !== 'select') return;
    const s = useEditorStore.getState();
    const hitLayer = hitTestLayers(screenToDoc(e.clientX, e.clientY), s.layers);
    if (hitLayer?.type === 'text') {
      s.selectLayer(hitLayer.id);
      s.setEditingTextLayer(hitLayer.id);
    }
  };

  const cursors: Record<string, string> = {
    select: 'default',
    pan: gesture.current?.type === 'pan' ? 'grabbing' : 'grab',
    brush: 'crosshair',
    eraser: 'crosshair',
    line: 'crosshair',
    rect: 'crosshair',
    ellipse: 'crosshair',
    text: 'text',
    picker: 'copy',
  };

  if (!doc) return null;
  const zoomPct = camera ? Math.round(camera.zoom * 100) : 100;

  return (
    <div
      ref={viewportRef}
      className="relative flex-1 min-h-0 overflow-hidden bg-surface-container touch-none select-none"
      style={{ cursor: cursors[tool] }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={onDoubleClick}
    >
      {camera && (
        <div
          className="absolute canvas-checkerboard shadow-2xl"
          style={{
            left: 0,
            top: 0,
            width: doc.width,
            height: doc.height,
            transform: `translate(${camera.panX}px, ${camera.panY}px) scale(${camera.zoom})`,
            transformOrigin: '0 0',
          }}
        >
          {layers.map((layer: Layer) => (
            <LayerView key={layer.id} layer={layer} hidden={editingTextLayerId === layer.id} />
          ))}
        </div>
      )}
      {camera && <SelectionOverlay docToScreen={docToScreen} screenToDoc={screenToDoc} />}
      {camera && textEditing && <TextEditOverlay camera={camera} />}

      {/* Zoom controls */}
      <div className="absolute bottom-3 right-3 flex items-center gap-1 rounded-xl bg-surface/90 backdrop-blur border border-outline-variant/20 shadow-lg px-1 py-1">
        <button onClick={() => zoomCenter(1 / 1.25)} title="Zoom out" aria-label="Zoom out"
          className="w-9 h-9 lg:w-8 lg:h-8 rounded-lg hover:bg-surface-container-high flex items-center justify-center text-on-surface-variant">
          <Icon name="zoom_out" className="text-lg" />
        </button>
        <button
          onClick={() => { const cam = fitCamera(); if (cam) setCamera(cam); }}
          title="Fit to view"
          className="min-w-[3.25rem] h-9 lg:h-8 rounded-lg hover:bg-surface-container-high text-[11px] font-bold text-on-surface-variant px-1"
        >
          {zoomPct}%
        </button>
        <button onClick={() => zoomCenter(1.25)} title="Zoom in" aria-label="Zoom in"
          className="w-9 h-9 lg:w-8 lg:h-8 rounded-lg hover:bg-surface-container-high flex items-center justify-center text-on-surface-variant">
          <Icon name="zoom_in" className="text-lg" />
        </button>
      </div>

      {hint && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 bg-surface/95 border border-outline-variant/20 text-on-surface text-xs font-bold rounded-full px-4 py-2 shadow-lg pointer-events-none">
          {hint}
        </div>
      )}
    </div>
  );
}

function makeTextLayer(
  defaults: Pick<TextLayer, 'fontFamily' | 'fontSize' | 'fontWeight' | 'italic' | 'color' | 'align' | 'lineHeight'>,
  at: Point,
): TextLayer {
  return {
    id: crypto.randomUUID(),
    type: 'text',
    name: 'Text',
    visible: true,
    locked: false,
    opacity: 1,
    transform: { cx: at.x, cy: at.y, scaleX: 1, scaleY: 1, rotation: 0 },
    text: '',
    ...defaults,
  };
}
