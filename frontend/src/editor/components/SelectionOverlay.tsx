import { useRef } from 'react';
import type { Point } from '../types';
import { useEditorStore } from '../editorStore';
import {
  getIntrinsicSize, handleDocPositions, orientedCorners,
  resizeFromHandle, rotateFromHandle, type HandleId, type Size,
} from '../lib/transform';
import type { Transform } from '../types';

// Selection handles for the selected layer, drawn in SCREEN coordinates on an
// SVG covering the viewport (handle sizes stay constant at any zoom). The svg
// itself ignores pointer events; only handles receive them — moving the layer
// body is the viewport's job.

interface Props {
  docToScreen: (pt: Point) => Point;
  screenToDoc: (clientX: number, clientY: number) => Point;
}

type HandleGesture =
  | { type: 'resize'; handle: HandleId; startTransform: Transform; size: Size; layerId: string }
  | { type: 'rotate'; centerDoc: Point; startPointerDoc: Point; startRotation: number; startTransform: Transform; layerId: string };

const HANDLE_PX = 10;
const ROTATE_OFFSET_PX = 26;

export function SelectionOverlay({ docToScreen, screenToDoc }: Props) {
  const layer = useEditorStore((s) => (s.selectedLayerId ? s.layers.find((l) => l.id === s.selectedLayerId) ?? null : null));
  const tool = useEditorStore((s) => s.tool);
  const editingTextLayerId = useEditorStore((s) => s.editingTextLayerId);
  const updateLayer = useEditorStore((s) => s.updateLayer);
  const recordLayerProps = useEditorStore((s) => s.recordLayerProps);
  const gesture = useRef<HandleGesture | null>(null);

  if (!layer || tool !== 'select' || layer.locked || editingTextLayerId === layer.id) return null;

  const corners = orientedCorners(layer).map(docToScreen);
  const handles = handleDocPositions(layer);
  const centerS = docToScreen({ x: layer.transform.cx, y: layer.transform.cy });
  const topMidS = docToScreen(handles.n);
  const dirLen = Math.hypot(topMidS.x - centerS.x, topMidS.y - centerS.y) || 1;
  const rotatePos = {
    x: topMidS.x + ((topMidS.x - centerS.x) / dirLen) * ROTATE_OFFSET_PX,
    y: topMidS.y + ((topMidS.y - centerS.y) / dirLen) * ROTATE_OFFSET_PX,
  };

  const capture = (el: Element | null, pointerId: number) => {
    try { (el as SVGElement | null)?.setPointerCapture(pointerId); } catch { /* pointer already gone */ }
  };

  const startResize = (handle: HandleId) => (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    capture(e.currentTarget as Element, e.pointerId);
    gesture.current = {
      type: 'resize',
      handle,
      startTransform: { ...layer.transform },
      size: getIntrinsicSize(layer),
      layerId: layer.id,
    };
  };

  const startRotate = (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    capture(e.currentTarget as Element, e.pointerId);
    gesture.current = {
      type: 'rotate',
      centerDoc: { x: layer.transform.cx, y: layer.transform.cy },
      startPointerDoc: screenToDoc(e.clientX, e.clientY),
      startRotation: layer.transform.rotation,
      startTransform: { ...layer.transform },
      layerId: layer.id,
    };
  };

  const onMove = (e: React.PointerEvent) => {
    const g = gesture.current;
    if (!g) return;
    e.stopPropagation();
    const pointerDoc = screenToDoc(e.clientX, e.clientY);
    if (g.type === 'resize') {
      const next = resizeFromHandle(
        { transform: g.startTransform, size: g.size, handle: g.handle },
        pointerDoc,
        { uniform: !e.altKey },
      );
      updateLayer(g.layerId, { transform: next }, { history: false });
    } else {
      const rotation = rotateFromHandle(g.centerDoc, g.startPointerDoc, pointerDoc, g.startRotation, e.shiftKey);
      updateLayer(g.layerId, { transform: { ...g.startTransform, rotation } }, { history: false });
    }
  };

  const onUp = (e: React.PointerEvent) => {
    const g = gesture.current;
    if (!g) return;
    e.stopPropagation();
    gesture.current = null;
    const cur = useEditorStore.getState().layers.find((l) => l.id === g.layerId);
    if (!cur) return;
    const before = g.startTransform;
    const after = cur.transform;
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      recordLayerProps(g.layerId, { transform: before }, { transform: after });
    }
  };

  const handleCursor: Record<HandleId, string> = {
    nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize',
    n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
  };

  return (
    <svg className="absolute inset-0 w-full h-full overflow-visible" style={{ pointerEvents: 'none' }}>
      <polygon
        points={corners.map((c) => `${c.x},${c.y}`).join(' ')}
        fill="none"
        stroke="var(--color-primary)"
        strokeWidth={1.5}
        strokeDasharray="5 3"
      />
      {/* rotate handle stem + knob */}
      <line x1={topMidS.x} y1={topMidS.y} x2={rotatePos.x} y2={rotatePos.y} stroke="var(--color-primary)" strokeWidth={1.5} />
      <circle
        cx={rotatePos.x} cy={rotatePos.y} r={HANDLE_PX * 0.7}
        fill="white" stroke="var(--color-primary)" strokeWidth={1.5}
        style={{ pointerEvents: 'auto', cursor: 'grab', touchAction: 'none' }}
        onPointerDown={startRotate} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
      />
      {(Object.keys(handles) as HandleId[]).map((id) => {
        const pos = docToScreen(handles[id]);
        return (
          <rect
            key={id}
            x={pos.x - HANDLE_PX / 2} y={pos.y - HANDLE_PX / 2}
            width={HANDLE_PX} height={HANDLE_PX} rx={2}
            fill="white" stroke="var(--color-primary)" strokeWidth={1.5}
            style={{ pointerEvents: 'auto', cursor: handleCursor[id], touchAction: 'none' }}
            onPointerDown={startResize(id)} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
          />
        );
      })}
    </svg>
  );
}
