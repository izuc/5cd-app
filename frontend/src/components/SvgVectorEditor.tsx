import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './Icon';

// kebab-case attribute -> camelCase for React SVG props
const kebabToCamel = (s: string) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

type Tool = 'select' | 'rect' | 'move' | 'pan' | 'paint' | 'pick';

interface El {
  id: string;
  type: string;
  fill: string;
  el: Element;
  bounds?: { x: number; y: number; width: number; height: number };
}

type View = { x: number; y: number; w: number; h: number };

function pathBounds(d: string) {
  const nums = d.match(/-?\d+\.?\d*/g);
  if (!nums || nums.length < 2) return undefined;
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i + 1 < nums.length; i += 2) { xs.push(parseFloat(nums[i])); ys.push(parseFloat(nums[i + 1])); }
  if (!xs.length) return undefined;
  return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
}

// Offset bounds by a leading translate(tx ty) transform, if present (shapes moved
// with the move tool carry one) — keeps rubber-band selection accurate.
function translateOf(el: Element): { tx: number; ty: number } {
  const t = el.getAttribute('transform') || '';
  const m = t.match(/^\s*translate\(\s*(-?[\d.]+)[ ,]+(-?[\d.]+)\s*\)/);
  return m ? { tx: parseFloat(m[1]), ty: parseFloat(m[2]) } : { tx: 0, ty: 0 };
}

function elBounds(el: Element, vb: number[]): El['bounds'] {
  const t = el.tagName.toLowerCase();
  const num = (a: string, d = 0) => parseFloat(el.getAttribute(a) || String(d));
  let b: El['bounds'];
  if (t === 'path') b = el.getAttribute('d') ? pathBounds(el.getAttribute('d')!) : undefined;
  else if (t === 'rect') {
    const pw = (el.getAttribute('width') || '').includes('%');
    const ph = (el.getAttribute('height') || '').includes('%');
    b = { x: num('x'), y: num('y'), width: pw ? vb[2] : num('width'), height: ph ? vb[3] : num('height') };
  } else if (t === 'circle') { const r = num('r'); b = { x: num('cx') - r, y: num('cy') - r, width: r * 2, height: r * 2 }; }
  else if (t === 'ellipse') { const rx = num('rx'), ry = num('ry'); b = { x: num('cx') - rx, y: num('cy') - ry, width: rx * 2, height: ry * 2 }; }
  if (b) { const { tx, ty } = translateOf(el); if (tx || ty) b = { ...b, x: b.x + tx, y: b.y + ty }; }
  return b;
}

export function SvgVectorEditor({ svg, onChange }: { svg: string; onChange: (svg: string) => void }) {
  const [tool, setTool] = useState<Tool>('select');
  const [paint, setPaint] = useState('#2563eb');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [hover, setHover] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [view, setView] = useState<View | null>(null); // null = fit whole viewBox
  const [moveDelta, setMoveDelta] = useState<{ dx: number; dy: number } | null>(null);

  const svgRef = useRef<SVGSVGElement | null>(null);
  const ptrs = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<
    | null
    | { type: 'pan'; start: { x: number; y: number }; startView: View }
    | { type: 'pinch'; startDist: number; startView: View; mid: { x: number; y: number } }
    | { type: 'maybe-move'; id: string; start: { x: number; y: number } }
    | { type: 'move'; ids: string[]; start: { x: number; y: number } }
  >(null);
  const moved = useRef(false); // suppress click-to-deselect after a drag gesture

  const { doc, svgEl, vb, elements } = useMemo(() => {
    const d = new DOMParser().parseFromString(svg, 'image/svg+xml');
    const root = d.querySelector('svg');
    const viewBox = (root?.getAttribute('viewBox') || `0 0 ${root?.getAttribute('width') || 100} ${root?.getAttribute('height') || 100}`).split(/\s+/).map(Number);
    const els: El[] = [];
    if (root) {
      const used = new Set<string>();
      let n = 0;
      root.querySelectorAll('path, rect, circle, ellipse, polygon, polyline').forEach((el) => {
        let p = el.parentElement;
        while (p && p.tagName.toLowerCase() !== 'svg') {
          const tn = p.tagName.toLowerCase();
          if (tn === 'defs' || tn === 'mask' || tn === 'clippath' || tn === 'pattern') return;
          p = p.parentElement;
        }
        let id = el.getAttribute('id') || '';
        if (!id || used.has(id)) { while (used.has(`s${n}`)) n++; id = `s${n++}`; el.setAttribute('id', id); }
        used.add(id);
        els.push({ id, type: el.tagName.toLowerCase(), fill: el.getAttribute('fill') || '#000000', el, bounds: elBounds(el, viewBox) });
      });
    }
    return { doc: d, svgEl: root, vb: viewBox, elements: els };
  }, [svg]);

  // Reset the zoom when a different image/viewBox arrives (not on every edit).
  const vbKey = vb.join(' ');
  useEffect(() => { setView(null); }, [vbKey]);

  const v: View = view ?? { x: vb[0], y: vb[1], w: vb[2], h: vb[3] };
  const zoomPct = Math.round((vb[2] / v.w) * 100);

  const clampView = useCallback((nv: View): View => {
    const minW = vb[2] / 32; // 3200% max zoom
    const maxW = vb[2] * 1.25;
    let w = Math.min(Math.max(nv.w, minW), maxW);
    const scale = w / nv.w;
    let h = nv.h * scale;
    // keep the view overlapping the artwork
    const mx = vb[2] * 0.4, my = vb[3] * 0.4;
    const x = Math.min(Math.max(nv.x, vb[0] - mx), vb[0] + vb[2] + mx - w);
    const y = Math.min(Math.max(nv.y, vb[1] - my), vb[1] + vb[3] + my - h);
    return { x, y, w, h };
  }, [vb]);

  const zoomAt = useCallback((cx: number, cy: number, factor: number) => {
    setView((prev) => {
      const cur = prev ?? { x: vb[0], y: vb[1], w: vb[2], h: vb[3] };
      const w = cur.w / factor, h = cur.h / factor;
      return clampView({ x: cx - (cx - cur.x) / factor, y: cy - (cy - cur.y) / factor, w, h });
    });
  }, [vb, clampView]);

  const palette = useMemo(() => {
    const m = new Map<string, number>();
    elements.forEach((e) => m.set(e.fill.toLowerCase(), (m.get(e.fill.toLowerCase()) || 0) + 1));
    return Array.from(m.entries()).sort((a, b) => b[1] - a[1]).map(([hex, count]) => ({ hex, count }));
  }, [elements]);

  const commit = useCallback((mutate: (d: Document) => void) => {
    if (!doc) return;
    const clone = doc.cloneNode(true) as Document;
    mutate(clone);
    onChange(new XMLSerializer().serializeToString(clone));
  }, [doc, onChange]);

  const recolorIds = useCallback((ids: Iterable<string>, hex: string) => {
    commit((d) => { for (const id of ids) { const el = d.getElementById(id); if (!el) continue; el.setAttribute('fill', hex); if (el.getAttribute('stroke')) el.setAttribute('stroke', hex); } });
  }, [commit]);

  const deleteIds = useCallback((ids: Iterable<string>) => {
    commit((d) => { for (const id of ids) d.getElementById(id)?.remove(); });
    setSelected(new Set());
  }, [commit]);

  const moveIds = useCallback((ids: Iterable<string>, dx: number, dy: number) => {
    commit((d) => {
      for (const id of ids) {
        const el = d.getElementById(id);
        if (!el) continue;
        // Fold into an existing leading translate so repeated nudges stay one op.
        const prev = el.getAttribute('transform') || '';
        const m = prev.match(/^\s*translate\(\s*(-?[\d.]+)[ ,]+(-?[\d.]+)\s*\)\s*(.*)$/);
        if (m) {
          const rest = m[3] ? ` ${m[3]}` : '';
          el.setAttribute('transform', `translate(${(parseFloat(m[1]) + dx).toFixed(1)} ${(parseFloat(m[2]) + dy).toFixed(1)})${rest}`);
        } else {
          el.setAttribute('transform', `translate(${dx.toFixed(1)} ${dy.toFixed(1)})${prev ? ` ${prev}` : ''}`);
        }
      }
    });
  }, [commit]);

  const idsOfColor = useCallback((hex: string) => elements.filter((e) => e.fill.toLowerCase() === hex.toLowerCase()).map((e) => e.id), [elements]);

  // client px -> view (user) coordinates
  const toCoords = (clientX: number, clientY: number) => {
    const el = svgRef.current;
    if (!el) return { x: 0, y: 0 };
    const r = el.getBoundingClientRect();
    return { x: ((clientX - r.left) / r.width) * v.w + v.x, y: ((clientY - r.top) / r.height) * v.h + v.y };
  };
  const clientScale = () => {
    const el = svgRef.current;
    if (!el) return 1;
    return v.w / el.getBoundingClientRect().width;
  };

  // Wheel zoom needs a native non-passive listener (React's delegated wheel
  // listener is passive, so preventDefault there can't stop the page scroll).
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const c = toCoords(e.clientX, e.clientY);
      zoomAt(c.x, c.y, e.deltaY < 0 ? 1.2 : 1 / 1.2);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  });

  // Keyboard: Delete removes selection, Escape deselects.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && /^(input|textarea|select)$/i.test(t.tagName)) return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && selected.size) { e.preventDefault(); deleteIds(selected); }
      if (e.key === 'Escape') setSelected(new Set());
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected, deleteIds]);

  const onShape = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (moved.current) return; // that was a drag, not a click
    const el = elements.find((x) => x.id === id);
    if (tool === 'pick') { if (el) setPaint(el.fill); return; }
    if (tool === 'paint') { recolorIds([id], paint); return; }
    if (tool === 'select' || tool === 'move') {
      setSelected((prev) => {
        const s = new Set(prev);
        if (e.shiftKey) { s.has(id) ? s.delete(id) : s.add(id); }
        else if (s.has(id) && s.size === 1) s.clear();
        else { s.clear(); s.add(id); }
        return s;
      });
    }
  };

  const shapePointerDown = (id: string, e: React.PointerEvent) => {
    if (tool !== 'move' || e.button !== 0 || ptrs.current.size > 0) return;
    e.stopPropagation();
    ptrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    gesture.current = { type: 'maybe-move', id, start: { x: e.clientX, y: e.clientY } };
    moved.current = false;
  };

  const down = (e: React.PointerEvent<SVGSVGElement>) => {
    ptrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    moved.current = false;

    if (ptrs.current.size === 2) {
      // Pinch zoom takes over any other gesture.
      const [a, b] = [...ptrs.current.values()];
      gesture.current = {
        type: 'pinch',
        startDist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        startView: { ...v },
        mid: toCoords((a.x + b.x) / 2, (a.y + b.y) / 2),
      };
      setDrag(null);
      setMoveDelta(null);
      e.currentTarget.setPointerCapture(e.pointerId);
      return;
    }

    if (e.button === 1 || tool === 'pan') {
      gesture.current = { type: 'pan', start: { x: e.clientX, y: e.clientY }, startView: { ...v } };
      e.currentTarget.setPointerCapture(e.pointerId);
      return;
    }
    if (tool === 'rect') {
      e.currentTarget.setPointerCapture(e.pointerId);
      const c = toCoords(e.clientX, e.clientY);
      setDrag({ x0: c.x, y0: c.y, x1: c.x, y1: c.y });
      if (!e.shiftKey) setSelected(new Set());
    }
  };

  const move = (e: React.PointerEvent<SVGSVGElement>) => {
    if (ptrs.current.has(e.pointerId)) ptrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;

    if (g?.type === 'pinch' && ptrs.current.size >= 2) {
      const [a, b] = [...ptrs.current.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const factor = dist / g.startDist;
      const w = g.startView.w / factor, h = g.startView.h / factor;
      setView(clampView({ x: g.mid.x - (g.mid.x - g.startView.x) / factor, y: g.mid.y - (g.mid.y - g.startView.y) / factor, w, h }));
      moved.current = true;
      return;
    }
    if (g?.type === 'pan') {
      const s = clientScale() * (v.w / g.startView.w === 1 ? 1 : 1); // scale of startView
      const sc = g.startView.w / (svgRef.current?.getBoundingClientRect().width || 1);
      setView(clampView({ ...g.startView, x: g.startView.x - (e.clientX - g.start.x) * sc, y: g.startView.y - (e.clientY - g.start.y) * sc }));
      if (Math.hypot(e.clientX - g.start.x, e.clientY - g.start.y) > 3) moved.current = true;
      void s;
      return;
    }
    if (g?.type === 'maybe-move') {
      if (Math.hypot(e.clientX - g.start.x, e.clientY - g.start.y) > 4) {
        const ids = selected.has(g.id) ? [...selected] : [g.id];
        if (!selected.has(g.id)) setSelected(new Set([g.id]));
        gesture.current = { type: 'move', ids, start: g.start };
        svgRef.current?.setPointerCapture(e.pointerId);
        moved.current = true;
      }
      return;
    }
    if (g?.type === 'move') {
      const sc = clientScale();
      setMoveDelta({ dx: (e.clientX - g.start.x) * sc, dy: (e.clientY - g.start.y) * sc });
      moved.current = true;
      return;
    }
    if (drag) { const c = toCoords(e.clientX, e.clientY); setDrag({ ...drag, x1: c.x, y1: c.y }); }
  };

  const up = (e: React.PointerEvent<SVGSVGElement>) => {
    ptrs.current.delete(e.pointerId);
    const g = gesture.current;

    if (g?.type === 'pinch') { if (ptrs.current.size < 2) gesture.current = null; return; }
    if (g?.type === 'pan') { gesture.current = null; return; }
    if (g?.type === 'maybe-move') { gesture.current = null; return; }
    if (g?.type === 'move') {
      gesture.current = null;
      if (moveDelta && (Math.abs(moveDelta.dx) > 0.01 || Math.abs(moveDelta.dy) > 0.01)) moveIds(g.ids, moveDelta.dx, moveDelta.dy);
      setMoveDelta(null);
      return;
    }

    if (!drag) return;
    const r = { x: Math.min(drag.x0, drag.x1), y: Math.min(drag.y0, drag.y1), width: Math.abs(drag.x1 - drag.x0), height: Math.abs(drag.y1 - drag.y0) };
    setDrag(null);
    if (r.width < 1 || r.height < 1) return;
    const hit = (b?: El['bounds']) => !!b && !(b.x > r.x + r.width || b.x + b.width < r.x || b.y > r.y + r.height || b.y + b.height < r.y);
    setSelected((prev) => {
      const s = new Set(e.shiftKey ? prev : []);
      elements.forEach((el) => {
        const b = el.bounds;
        if (!b) return;
        // Don't rubber-band the full-canvas background — you want the bits, not the backdrop.
        if (b.width >= vb[2] * 0.95 && b.height >= vb[3] * 0.95) return;
        if (hit(b)) s.add(el.id);
      });
      return s;
    });
  };

  const sw = Math.max(v.w, v.h) / 250; // view-relative highlight stroke (stays visible at any zoom)
  const checker = 'repeating-conic-gradient(#e5e7eb 0% 25%, #ffffff 0% 50%) 50% / 18px 18px';
  const TOOLS: [Tool, string, string][] = [
    ['select', 'ads_click', 'Click select'],
    ['rect', 'select', 'Rectangle select'],
    ['move', 'open_with', 'Move selected shapes'],
    ['pan', 'pan_tool', 'Pan the view'],
    ['paint', 'format_color_fill', 'Fill with colour'],
    ['pick', 'colorize', 'Pick colour'],
  ];
  const cursors: Record<Tool, string> = {
    select: 'default', rect: 'crosshair', move: 'move', pan: gesture.current?.type === 'pan' ? 'grabbing' : 'grab', paint: 'cell', pick: 'copy',
  };
  const hoverOutline = hover && !selected.has(hover) && (tool === 'select' || tool === 'move' || tool === 'paint' || tool === 'pick');

  return (
    <div className="flex flex-col lg:flex-row gap-4 lg:h-full lg:min-h-0">
      {/* Canvas */}
      <div className="flex-1 lg:min-h-0 flex flex-col">
        <div className="flex items-center flex-wrap gap-1 mb-2">
          {TOOLS.map(([t, icon, label]) => (
            <button key={t} onClick={() => setTool(t)} title={label}
              className={`w-10 h-10 lg:w-9 lg:h-9 rounded-lg flex items-center justify-center transition-all ${tool === t ? 'bg-primary-container text-on-primary-container' : 'bg-surface-container-high text-on-surface-variant hover:bg-surface-container-highest'}`}>
              <Icon name={icon} className="text-lg" />
            </button>
          ))}
          <input type="color" value={paint} onChange={(e) => setPaint(e.target.value)} title="Paint colour"
            className="w-10 h-10 lg:w-9 lg:h-9 rounded-lg border-2 border-surface-container-high bg-transparent cursor-pointer p-0.5 ml-1" />
          <span className="mx-1 h-6 w-px bg-outline-variant/30 hidden sm:block" />
          <button onClick={() => zoomAt(v.x + v.w / 2, v.y + v.h / 2, 1.3)} title="Zoom in"
            className="w-10 h-10 lg:w-9 lg:h-9 rounded-lg bg-surface-container-high text-on-surface-variant hover:bg-surface-container-highest flex items-center justify-center"><Icon name="zoom_in" className="text-lg" /></button>
          <button onClick={() => zoomAt(v.x + v.w / 2, v.y + v.h / 2, 1 / 1.3)} title="Zoom out"
            className="w-10 h-10 lg:w-9 lg:h-9 rounded-lg bg-surface-container-high text-on-surface-variant hover:bg-surface-container-highest flex items-center justify-center"><Icon name="zoom_out" className="text-lg" /></button>
          <button onClick={() => setView(null)} title="Fit to view" disabled={!view}
            className="w-10 h-10 lg:w-9 lg:h-9 rounded-lg bg-surface-container-high text-on-surface-variant hover:bg-surface-container-highest flex items-center justify-center disabled:opacity-40"><Icon name="fit_screen" className="text-lg" /></button>
          <span className="text-[10px] text-on-surface-variant w-10 text-center">{zoomPct}%</span>
          <span className="ml-auto text-xs text-on-surface-variant">{elements.length} shapes · {selected.size} sel.</span>
        </div>

        <div className="flex-1 lg:min-h-0 overflow-hidden rounded-xl border border-outline-variant/20 flex items-center justify-center p-2" style={{ background: checker }}>
          {svgEl && (
            <svg ref={svgRef} viewBox={`${v.x} ${v.y} ${v.w} ${v.h}`} width={vb[2]} height={vb[3]} className="max-w-full"
              style={{ maxHeight: '52vh', touchAction: 'none', cursor: cursors[tool] }}
              onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
              onClick={() => { if ((tool === 'select' || tool === 'move') && !moved.current) setSelected(new Set()); }}>
              <defs dangerouslySetInnerHTML={{ __html: svgEl.querySelector('defs')?.innerHTML || '' }} />
              {elements.map((el) => {
                const attrs: Record<string, string> = {};
                for (let i = 0; i < el.el.attributes.length; i++) { const a = el.el.attributes[i]; if (a.name !== 'id') attrs[a.name === 'class' ? 'className' : kebabToCamel(a.name)] = a.value; }
                const Tag = el.type as any;
                const sel = selected.has(el.id);
                if (sel && moveDelta) {
                  attrs.transform = `translate(${moveDelta.dx} ${moveDelta.dy})${attrs.transform ? ` ${attrs.transform}` : ''}`;
                }
                return (
                  <g key={el.id}>
                    <Tag {...attrs} onClick={(e: React.MouseEvent) => onShape(el.id, e)}
                      onPointerDown={(e: React.PointerEvent) => shapePointerDown(el.id, e)}
                      onPointerEnter={() => setHover(el.id)} onPointerLeave={() => setHover((h) => (h === el.id ? null : h))}
                      style={{ cursor: 'inherit' }} />
                    {sel && <Tag {...attrs} fill="none" stroke="#0078ff" strokeWidth={sw} strokeDasharray={`${sw * 2} ${sw * 1.2}`} pointerEvents="none" />}
                    {hoverOutline && hover === el.id && <Tag {...attrs} fill="none" stroke="#22c55e" strokeWidth={sw * 0.8} pointerEvents="none" />}
                  </g>
                );
              })}
              {drag && (
                <rect x={Math.min(drag.x0, drag.x1)} y={Math.min(drag.y0, drag.y1)} width={Math.abs(drag.x1 - drag.x0)} height={Math.abs(drag.y1 - drag.y0)}
                  fill="rgba(29,155,240,0.18)" stroke="#1d9bf0" strokeWidth={sw * 0.7} pointerEvents="none" />
              )}
            </svg>
          )}
        </div>
        <p className="text-[11px] text-on-surface-variant mt-1.5">
          {tool === 'select' && 'Tap a shape to select (Shift = multi). Scroll or pinch to zoom. Delete key removes the selection.'}
          {tool === 'rect' && 'Drag a box to select shapes inside it (the background is left out).'}
          {tool === 'move' && 'Drag a shape to move it (moves the whole selection). Tap to select first.'}
          {tool === 'pan' && 'Drag to pan the view. Scroll or pinch to zoom.'}
          {tool === 'paint' && 'Tap any shape to fill it with the paint colour.'}
          {tool === 'pick' && 'Tap a shape to copy its colour into the paint swatch.'}
        </p>
      </div>

      {/* Right rail */}
      <div className="lg:w-60 shrink-0 space-y-4 lg:overflow-y-auto">
        <div>
          <p className="font-label text-xs uppercase tracking-widest text-on-surface-variant font-bold mb-2">Colours</p>
          <div className="space-y-1.5">
            {palette.map(({ hex, count }) => (
              <div key={hex} className="flex items-center gap-2">
                <button onClick={() => setSelected(new Set(idsOfColor(hex)))} title="Select all of this colour"
                  className="flex items-center gap-2 flex-1 min-w-0 rounded-lg px-2 py-1.5 bg-surface-container-high hover:bg-surface-container-highest text-left">
                  <span className="w-5 h-5 rounded border border-black/10 shrink-0" style={{ background: hex }} />
                  <span className="text-xs truncate">{hex}</span>
                  <span className="text-[10px] text-on-surface-variant ml-auto">{count}</span>
                </button>
                <button onClick={() => recolorIds(idsOfColor(hex), paint)} title="Recolour all of this colour to the paint colour"
                  className="w-8 h-8 rounded-lg bg-surface-container-high hover:bg-surface-container-highest flex items-center justify-center">
                  <Icon name="format_color_fill" className="text-sm" />
                </button>
                <button onClick={() => deleteIds(idsOfColor(hex))} title="Remove all shapes of this colour (e.g. the background)"
                  className="w-8 h-8 rounded-lg bg-surface-container-high hover:bg-error-container hover:text-on-error-container flex items-center justify-center">
                  <Icon name="delete" className="text-sm" />
                </button>
              </div>
            ))}
          </div>
        </div>

        <div>
          <p className="font-label text-xs uppercase tracking-widest text-on-surface-variant font-bold mb-2">Selection</p>
          <div className="grid grid-cols-2 gap-1.5">
            <button onClick={() => setSelected(new Set(elements.map((e) => e.id)))} className="text-xs py-2 rounded-lg bg-surface-container-high hover:bg-surface-container-highest">Select all</button>
            <button onClick={() => setSelected(new Set())} disabled={!selected.size} className="text-xs py-2 rounded-lg bg-surface-container-high hover:bg-surface-container-highest disabled:opacity-40">Deselect</button>
            <button onClick={() => setSelected(new Set(elements.filter((e) => !selected.has(e.id)).map((e) => e.id)))} className="text-xs py-2 rounded-lg bg-surface-container-high hover:bg-surface-container-highest">Invert</button>
            <button onClick={() => deleteIds(selected)} disabled={!selected.size} className="text-xs py-2 rounded-lg bg-surface-container-high hover:bg-error-container hover:text-on-error-container disabled:opacity-40">Delete</button>
          </div>
          <button onClick={() => recolorIds(selected, paint)} disabled={!selected.size}
            className="w-full mt-1.5 text-xs py-2.5 rounded-lg bg-primary-container text-on-primary-container font-bold disabled:opacity-40 flex items-center justify-center gap-1.5">
            <Icon name="format_color_fill" className="text-sm" /> Apply paint colour
          </button>
        </div>
      </div>
    </div>
  );
}
