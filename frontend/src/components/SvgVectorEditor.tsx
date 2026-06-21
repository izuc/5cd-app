import { useCallback, useMemo, useState } from 'react';
import { Icon } from './Icon';

// kebab-case attribute -> camelCase for React SVG props
const kebabToCamel = (s: string) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

type Tool = 'select' | 'rect' | 'paint' | 'pick';

interface El {
  id: string;
  type: string;
  fill: string;
  el: Element;
  bounds?: { x: number; y: number; width: number; height: number };
}

function pathBounds(d: string) {
  const nums = d.match(/-?\d+\.?\d*/g);
  if (!nums || nums.length < 2) return undefined;
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i + 1 < nums.length; i += 2) { xs.push(parseFloat(nums[i])); ys.push(parseFloat(nums[i + 1])); }
  if (!xs.length) return undefined;
  return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
}

function elBounds(el: Element, vb: number[]): El['bounds'] {
  const t = el.tagName.toLowerCase();
  const num = (a: string, d = 0) => parseFloat(el.getAttribute(a) || String(d));
  if (t === 'path') return el.getAttribute('d') ? pathBounds(el.getAttribute('d')!) : undefined;
  if (t === 'rect') {
    const pw = (el.getAttribute('width') || '').includes('%');
    const ph = (el.getAttribute('height') || '').includes('%');
    return { x: num('x'), y: num('y'), width: pw ? vb[2] : num('width'), height: ph ? vb[3] : num('height') };
  }
  if (t === 'circle') { const r = num('r'); return { x: num('cx') - r, y: num('cy') - r, width: r * 2, height: r * 2 }; }
  if (t === 'ellipse') { const rx = num('rx'), ry = num('ry'); return { x: num('cx') - rx, y: num('cy') - ry, width: rx * 2, height: ry * 2 }; }
  return undefined;
}

export function SvgVectorEditor({ svg, onChange }: { svg: string; onChange: (svg: string) => void }) {
  const [tool, setTool] = useState<Tool>('select');
  const [paint, setPaint] = useState('#2563eb');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);

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

  const idsOfColor = useCallback((hex: string) => elements.filter((e) => e.fill.toLowerCase() === hex.toLowerCase()).map((e) => e.id), [elements]);

  const toCoords = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * vb[2] + vb[0], y: ((e.clientY - r.top) / r.height) * vb[3] + vb[1] };
  };

  const onShape = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const el = elements.find((x) => x.id === id);
    if (tool === 'pick') { if (el) setPaint(el.fill); return; }
    if (tool === 'paint') { recolorIds([id], paint); return; }
    if (tool === 'select') {
      setSelected((prev) => {
        const s = new Set(prev);
        if (e.shiftKey) { s.has(id) ? s.delete(id) : s.add(id); }
        else if (s.has(id) && s.size === 1) s.clear();
        else { s.clear(); s.add(id); }
        return s;
      });
    }
  };

  const down = (e: React.PointerEvent<SVGSVGElement>) => {
    if (tool !== 'rect') return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const c = toCoords(e);
    setDrag({ x0: c.x, y0: c.y, x1: c.x, y1: c.y });
    if (!e.shiftKey) setSelected(new Set());
  };
  const move = (e: React.PointerEvent<SVGSVGElement>) => { if (drag) { const c = toCoords(e); setDrag({ ...drag, x1: c.x, y1: c.y }); } };
  const up = (e: React.PointerEvent<SVGSVGElement>) => {
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

  const sw = Math.max(vb[2], vb[3]) / 250; // viewBox-relative highlight stroke (resolution independent)
  const checker = 'repeating-conic-gradient(#e5e7eb 0% 25%, #ffffff 0% 50%) 50% / 18px 18px';
  const TOOLS: [Tool, string, string][] = [
    ['select', 'ads_click', 'Click select'],
    ['rect', 'select', 'Rectangle select'],
    ['paint', 'format_color_fill', 'Fill with colour'],
    ['pick', 'colorize', 'Pick colour'],
  ];

  return (
    <div className="flex flex-col lg:flex-row gap-4 lg:h-full lg:min-h-0">
      {/* Canvas */}
      <div className="flex-1 lg:min-h-0 flex flex-col">
        <div className="flex items-center flex-wrap gap-1 mb-2">
          {TOOLS.map(([t, icon, label]) => (
            <button key={t} onClick={() => setTool(t)} title={label}
              className={`w-9 h-9 rounded-lg flex items-center justify-center transition-all ${tool === t ? 'bg-primary-container text-on-primary-container' : 'bg-surface-container-high text-on-surface-variant hover:bg-surface-container-highest'}`}>
              <Icon name={icon} className="text-lg" />
            </button>
          ))}
          <input type="color" value={paint} onChange={(e) => setPaint(e.target.value)} title="Paint colour"
            className="w-9 h-9 rounded-lg border-2 border-surface-container-high bg-transparent cursor-pointer p-0.5 ml-1" />
          <span className="ml-auto text-xs text-on-surface-variant">{elements.length} shapes · {selected.size} sel.</span>
        </div>

        <div className="flex-1 lg:min-h-0 overflow-auto rounded-xl border border-outline-variant/20 flex items-center justify-center p-2" style={{ background: checker }}>
          {svgEl && (
            <svg viewBox={vb.join(' ')} width={vb[2]} height={vb[3]} className="max-w-full"
              style={{ maxHeight: '52vh', touchAction: 'none', cursor: tool === 'rect' ? 'crosshair' : tool === 'paint' ? 'cell' : tool === 'pick' ? 'copy' : 'default' }}
              onPointerDown={down} onPointerMove={move} onPointerUp={up}
              onClick={() => { if (tool === 'select') setSelected(new Set()); }}>
              <defs dangerouslySetInnerHTML={{ __html: svgEl.querySelector('defs')?.innerHTML || '' }} />
              {elements.map((el) => {
                const attrs: Record<string, string> = {};
                for (let i = 0; i < el.el.attributes.length; i++) { const a = el.el.attributes[i]; if (a.name !== 'id') attrs[a.name === 'class' ? 'className' : kebabToCamel(a.name)] = a.value; }
                const Tag = el.type as any;
                const sel = selected.has(el.id);
                return (
                  <g key={el.id}>
                    <Tag {...attrs} onClick={(e: React.MouseEvent) => onShape(el.id, e)} style={{ cursor: 'inherit' }} />
                    {sel && <Tag {...attrs} fill="none" stroke="#0078ff" strokeWidth={sw} strokeDasharray={`${sw * 2} ${sw * 1.2}`} pointerEvents="none" />}
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
          {tool === 'select' && 'Tap a shape to select (Shift = multi). Tap empty space to deselect.'}
          {tool === 'rect' && 'Drag a box to select shapes inside it (the background is left out).'}
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
