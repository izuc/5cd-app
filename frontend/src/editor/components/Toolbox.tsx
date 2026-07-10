import { Icon } from '../../components/Icon';
import type { TextLayer, Tool } from '../types';
import { useEditorStore } from '../editorStore';
import { FontPicker } from './FontPicker';

// Tool rail: horizontal strip above the stage on mobile, vertical rail beside
// it on desktop (same flip as the page's lg boundary). Button sizing follows
// SvgVectorEditor (w-10 h-10, lg:w-9 lg:h-9).

const TOOLS: [Tool, string, string][] = [
  ['select', 'arrow_selector_tool', 'Select / move (V)'],
  ['pan', 'pan_tool', 'Pan the view'],
  ['brush', 'brush', 'Brush (B)'],
  ['eraser', 'ink_eraser', 'Eraser (E)'],
  ['line', 'pen_size_2', 'Line'],
  ['rect', 'rectangle', 'Rectangle'],
  ['ellipse', 'circle', 'Ellipse'],
  ['text', 'title', 'Text (T)'],
  ['picker', 'colorize', 'Pick colour'],
];

export function Toolbox() {
  const tool = useEditorStore((s) => s.tool);
  const setTool = useEditorStore((s) => s.setTool);
  const canUndo = useEditorStore((s) => s.past.length > 0);
  const canRedo = useEditorStore((s) => s.future.length > 0);
  const undo = useEditorStore((s) => s.undo);
  const redo = useEditorStore((s) => s.redo);

  const btn = (active: boolean) =>
    `w-10 h-10 lg:w-9 lg:h-9 rounded-lg flex items-center justify-center flex-shrink-0 transition-all ${
      active
        ? 'bg-primary-container text-on-primary-container'
        : 'bg-surface-container-high text-on-surface-variant hover:bg-surface-container-highest'
    }`;

  return (
    <div className="flex flex-row flex-wrap justify-center lg:flex-col lg:flex-nowrap lg:justify-start items-center gap-1 p-1.5 bg-surface-container-lowest border-b lg:border-b-0 lg:border-r border-outline-variant/10 lg:overflow-y-auto scrollbar-none flex-shrink-0">
      {TOOLS.map(([t, icon, label]) => (
        <button key={t} onClick={() => setTool(t)} title={label} aria-label={label} className={btn(tool === t)}>
          <Icon name={icon} className="text-lg" />
        </button>
      ))}
      <span className="w-px h-6 lg:w-6 lg:h-px bg-outline-variant/30 mx-1 lg:mx-0 lg:my-1 flex-shrink-0" />
      <button onClick={undo} disabled={!canUndo} title="Undo (Ctrl+Z)" aria-label="Undo"
        className={`${btn(false)} disabled:opacity-40`}>
        <Icon name="undo" className="text-lg" />
      </button>
      <button onClick={redo} disabled={!canRedo} title="Redo (Ctrl+Y)" aria-label="Redo"
        className={`${btn(false)} disabled:opacity-40`}>
        <Icon name="redo" className="text-lg" />
      </button>
    </div>
  );
}

/** Contextual options bar for the active tool (and for a selected text layer). */
export function ToolOptions() {
  const tool = useEditorStore((s) => s.tool);
  const brush = useEditorStore((s) => s.brush);
  const eraser = useEditorStore((s) => s.eraser);
  const shape = useEditorStore((s) => s.shape);
  const textDefaults = useEditorStore((s) => s.textDefaults);
  const setBrush = useEditorStore((s) => s.setBrush);
  const setEraser = useEditorStore((s) => s.setEraser);
  const setShape = useEditorStore((s) => s.setShape);
  const selectedText = useEditorStore((s) => {
    const l = s.layers.find((x) => x.id === s.selectedLayerId);
    return l && l.type === 'text' ? l : null;
  });
  const draft = useEditorStore((s) => s.editingTextDraft);

  // Text styling routes to the draft, the selected text layer, and the
  // defaults for future layers — whichever applies.
  const applyTextStyle = (patch: Partial<Pick<TextLayer, 'fontFamily' | 'fontSize' | 'fontWeight' | 'italic' | 'color' | 'align' | 'lineHeight'>>) => {
    const s = useEditorStore.getState();
    if (s.editingTextDraft) s.setEditingTextDraft({ ...s.editingTextDraft, ...patch });
    const sel = s.layers.find((x) => x.id === s.selectedLayerId);
    if (sel && sel.type === 'text') s.updateLayer(sel.id, patch);
    s.setTextDefaults(patch);
  };

  const label = (text: string) => (
    <span className="font-label text-[10px] uppercase tracking-widest text-on-surface-variant font-bold whitespace-nowrap">{text}</span>
  );
  const colorInput = (value: string, onChange: (hex: string) => void, title: string) => (
    <input type="color" value={value} onChange={(e) => onChange(e.target.value)} title={title}
      className="w-9 h-9 lg:w-8 lg:h-8 rounded-lg border-2 border-surface-container-high bg-transparent cursor-pointer p-0.5 flex-shrink-0" />
  );
  const slider = (value: number, min: number, max: number, onChange: (v: number) => void, title: string, step = 1) => (
    <input type="range" min={min} max={max} step={step} value={value} title={title}
      onChange={(e) => onChange(parseFloat(e.target.value))}
      className="w-24 sm:w-28 h-2 accent-primary cursor-pointer touch-pan-y py-2" />
  );

  const showText = tool === 'text' || !!selectedText || !!draft;
  const showBrush = tool === 'brush';
  const showEraser = tool === 'eraser';
  const showShape = tool === 'line' || tool === 'rect' || tool === 'ellipse';
  if (!showText && !showBrush && !showEraser && !showShape) return null;

  const textState = draft ?? selectedText ?? { ...textDefaults };

  return (
    <div className="flex items-center flex-wrap gap-x-3 gap-y-1.5 px-3 py-1.5 bg-surface-container-lowest border-b border-outline-variant/10 flex-shrink-0">
      {showBrush && (
        <>
          {colorInput(brush.color, (c) => setBrush({ color: c }), 'Brush colour')}
          {label('Size')}
          {slider(brush.size, 1, 128, (v) => setBrush({ size: v }), 'Brush size')}
          <span className="text-[10px] text-on-surface-variant w-8">{brush.size}px</span>
          {label('Opacity')}
          {slider(Math.round(brush.opacity * 100), 5, 100, (v) => setBrush({ opacity: v / 100 }), 'Brush opacity')}
          <span className="text-[10px] text-on-surface-variant w-8">{Math.round(brush.opacity * 100)}%</span>
        </>
      )}
      {showEraser && (
        <>
          {label('Size')}
          {slider(eraser.size, 2, 200, (v) => setEraser({ size: v }), 'Eraser size')}
          <span className="text-[10px] text-on-surface-variant w-8">{eraser.size}px</span>
        </>
      )}
      {showShape && (
        <>
          {colorInput(shape.stroke, (c) => setShape({ stroke: c }), 'Stroke colour')}
          {label('Width')}
          {slider(shape.strokeWidth, 1, 64, (v) => setShape({ strokeWidth: v }), 'Stroke width')}
          {tool !== 'line' && (
            <>
              <label className="flex items-center gap-1.5 text-xs text-on-surface-variant whitespace-nowrap cursor-pointer">
                <input type="checkbox" checked={shape.fill !== null}
                  onChange={(e) => setShape({ fill: e.target.checked ? shape.stroke : null })}
                  className="accent-primary w-4 h-4" />
                Fill
              </label>
              {shape.fill !== null && colorInput(shape.fill, (c) => setShape({ fill: c }), 'Fill colour')}
            </>
          )}
        </>
      )}
      {showText && (
        <>
          <FontPicker value={textState.fontFamily} onChange={(fontFamily) => applyTextStyle({ fontFamily })} />
          <input type="number" min={8} max={512} value={textState.fontSize} title="Font size"
            onChange={(e) => applyTextStyle({ fontSize: Math.max(8, Math.min(512, parseInt(e.target.value) || 8)) })}
            className="w-16 h-9 lg:h-8 rounded-lg bg-surface-container-high text-xs font-bold px-2" />
          <button onClick={() => applyTextStyle({ fontWeight: textState.fontWeight === 700 ? 400 : 700 })}
            title="Bold" aria-label="Bold"
            className={`w-9 h-9 lg:w-8 lg:h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${textState.fontWeight === 700 ? 'bg-primary-container text-on-primary-container' : 'bg-surface-container-high text-on-surface-variant'}`}>
            <Icon name="format_bold" className="text-lg" />
          </button>
          <button onClick={() => applyTextStyle({ italic: !textState.italic })}
            title="Italic" aria-label="Italic"
            className={`w-9 h-9 lg:w-8 lg:h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${textState.italic ? 'bg-primary-container text-on-primary-container' : 'bg-surface-container-high text-on-surface-variant'}`}>
            <Icon name="format_italic" className="text-lg" />
          </button>
          {(['left', 'center', 'right'] as const).map((a) => (
            <button key={a} onClick={() => applyTextStyle({ align: a })} title={`Align ${a}`} aria-label={`Align ${a}`}
              className={`w-9 h-9 lg:w-8 lg:h-8 rounded-lg items-center justify-center flex-shrink-0 hidden sm:flex ${textState.align === a ? 'bg-primary-container text-on-primary-container' : 'bg-surface-container-high text-on-surface-variant'}`}>
              <Icon name={`format_align_${a}`} className="text-lg" />
            </button>
          ))}
          {colorInput(textState.color, (c) => applyTextStyle({ color: c }), 'Text colour')}
        </>
      )}
    </div>
  );
}
