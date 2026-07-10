import { useRef, useState } from 'react';
import { Icon } from '../../components/Icon';
import type { Layer, RasterLayer } from '../types';
import { useEditorStore } from '../editorStore';
import { createBitmap } from '../bitmapRegistry';
import { LayerThumbnail } from './LayerThumbnail';

// Layer stack (top layer first). The selected row expands with opacity +
// reorder/duplicate/delete actions to keep rows compact.

export function LayersPanel({ onRequestAiLayer }: { onRequestAiLayer?: (layer: Layer | null) => void }) {
  const doc = useEditorStore((s) => s.doc);
  const layers = useEditorStore((s) => s.layers);
  const selectedLayerId = useEditorStore((s) => s.selectedLayerId);
  const bitmapRevs = useEditorStore((s) => s.bitmapRevs);
  const selectLayer = useEditorStore((s) => s.selectLayer);
  const [collapsed, setCollapsed] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);

  if (!doc) return null;

  const addPaintLayer = () => {
    const s = useEditorStore.getState();
    if (!s.doc) return;
    const id = crypto.randomUUID();
    createBitmap(id, s.doc.width, s.doc.height);
    const count = s.layers.filter((l) => l.type === 'raster').length;
    const layer: RasterLayer = {
      id,
      type: 'raster',
      name: `Paint ${count}`,
      visible: true,
      locked: false,
      opacity: 1,
      transform: { cx: s.doc.width / 2, cy: s.doc.height / 2, scaleX: 1, scaleY: 1, rotation: 0 },
      pixelWidth: s.doc.width,
      pixelHeight: s.doc.height,
    };
    s.addLayer(layer);
  };

  const startText = () => {
    useEditorStore.getState().setTool('text');
  };

  const ordered = layers.slice().reverse();

  return (
    <div className="border-b border-outline-variant/10 bg-surface flex flex-col min-h-0">
      <div className="flex items-center gap-2 px-4 py-2.5">
        <button onClick={() => setCollapsed((c) => !c)} className="flex items-center gap-1.5 min-w-0" aria-expanded={!collapsed}>
          <Icon name={collapsed ? 'expand_more' : 'expand_less'} className="text-base text-on-surface-variant" />
          <span className="font-headline font-bold text-sm">Layers</span>
          <span className="text-[10px] text-on-surface-variant">{layers.length}</span>
        </button>
        <div className="ml-auto flex items-center gap-1">
          <button onClick={addPaintLayer} title="Add paint layer"
            className="w-9 h-9 lg:w-8 lg:h-8 rounded-lg bg-surface-container-high hover:bg-surface-container-highest flex items-center justify-center text-on-surface-variant">
            <Icon name="add" className="text-lg" />
          </button>
          <button onClick={startText} title="Add text (click the canvas to place it)"
            className="w-9 h-9 lg:w-8 lg:h-8 rounded-lg bg-surface-container-high hover:bg-surface-container-highest flex items-center justify-center text-on-surface-variant">
            <Icon name="title" className="text-lg" />
          </button>
          {onRequestAiLayer && (
            <button onClick={() => onRequestAiLayer(null)} title="Generate a new layer with AI"
              className="w-9 h-9 lg:w-8 lg:h-8 rounded-lg bg-primary-container text-on-primary-container hover:opacity-90 flex items-center justify-center">
              <Icon name="auto_awesome" className="text-lg" />
            </button>
          )}
        </div>
      </div>

      {!collapsed && (
        <div className="overflow-y-auto max-h-56 lg:max-h-[30vh] px-2 pb-2 space-y-1">
          {ordered.map((layer) => (
            <LayerRow
              key={layer.id}
              layer={layer}
              rev={bitmapRevs[layer.id] || 0}
              selected={layer.id === selectedLayerId}
              renaming={renamingId === layer.id}
              onSelect={() => selectLayer(layer.id)}
              onStartRename={() => setRenamingId(layer.id)}
              onEndRename={() => setRenamingId(null)}
              onRequestAiLayer={onRequestAiLayer}
            />
          ))}
          {layers.length === 0 && (
            <p className="text-xs text-on-surface-variant text-center py-3">No layers yet.</p>
          )}
        </div>
      )}
    </div>
  );
}

function LayerRow({
  layer, rev, selected, renaming,
  onSelect, onStartRename, onEndRename, onRequestAiLayer,
}: {
  layer: Layer;
  rev: number;
  selected: boolean;
  renaming: boolean;
  onSelect: () => void;
  onStartRename: () => void;
  onEndRename: () => void;
  onRequestAiLayer?: (layer: Layer | null) => void;
}) {
  const updateLayer = useEditorStore((s) => s.updateLayer);
  const removeLayer = useEditorStore((s) => s.removeLayer);
  const duplicateLayer = useEditorStore((s) => s.duplicateLayer);
  const reorderLayer = useEditorStore((s) => s.reorderLayer);
  const layerCount = useEditorStore((s) => s.layers.length);
  const index = useEditorStore((s) => s.layers.findIndex((l) => l.id === layer.id));
  const opacityStart = useRef(layer.opacity);

  const iconBtn = 'w-8 h-8 rounded-lg hover:bg-surface-container-highest flex items-center justify-center text-on-surface-variant disabled:opacity-40';

  return (
    <div
      className={`rounded-xl border transition-all ${
        selected ? 'border-primary/50 bg-primary-container/10' : 'border-transparent hover:bg-surface-container-high/60'
      }`}
    >
      <div className="flex items-center gap-2 px-2 py-1.5 cursor-pointer" onClick={onSelect}>
        <LayerThumbnail layer={layer} rev={rev} />
        <div className="flex-1 min-w-0">
          {renaming ? (
            <input
              autoFocus
              defaultValue={layer.name}
              onClick={(e) => e.stopPropagation()}
              onBlur={(e) => {
                const name = e.target.value.trim();
                if (name && name !== layer.name) updateLayer(layer.id, { name });
                onEndRename();
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                if (e.key === 'Escape') onEndRename();
              }}
              className="w-full bg-surface-container-lowest border border-outline-variant/30 rounded-lg px-2 py-1 text-xs"
            />
          ) : (
            <p
              className="text-xs font-bold truncate"
              onDoubleClick={(e) => { e.stopPropagation(); onStartRename(); }}
              title={`${layer.name} — double-click to rename`}
            >
              {layer.name}
            </p>
          )}
          <p className="text-[10px] text-on-surface-variant">{layer.type === 'text' ? 'Text' : 'Paint'}</p>
        </div>
        <button
          onClick={(e) => { e.stopPropagation(); updateLayer(layer.id, { visible: !layer.visible }); }}
          title={layer.visible ? 'Hide layer' : 'Show layer'}
          className={iconBtn}
        >
          <Icon name={layer.visible ? 'visibility' : 'visibility_off'} className="text-base" />
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); updateLayer(layer.id, { locked: !layer.locked }); }}
          title={layer.locked ? 'Unlock layer' : 'Lock layer'}
          className={iconBtn}
        >
          <Icon name={layer.locked ? 'lock' : 'lock_open'} className="text-base" filled={layer.locked} />
        </button>
      </div>

      {selected && (
        <div className="flex items-center gap-1.5 px-2 pb-2 flex-wrap">
          <Icon name="opacity" className="text-sm text-on-surface-variant" />
          <input
            type="range" min={5} max={100}
            value={Math.round(layer.opacity * 100)}
            title="Layer opacity"
            onPointerDown={() => { opacityStart.current = layer.opacity; }}
            onChange={(e) => updateLayer(layer.id, { opacity: parseInt(e.target.value) / 100 }, { history: false })}
            onPointerUp={() => {
              const cur = useEditorStore.getState().layers.find((l) => l.id === layer.id);
              if (cur && cur.opacity !== opacityStart.current) {
                useEditorStore.getState().recordLayerProps(layer.id, { opacity: opacityStart.current }, { opacity: cur.opacity });
              }
            }}
            className="flex-1 min-w-[4rem] h-2 accent-primary cursor-pointer touch-pan-y py-2"
          />
          <button onClick={() => reorderLayer(layer.id, 1)} disabled={index >= layerCount - 1} title="Move up" className={iconBtn}>
            <Icon name="arrow_upward" className="text-base" />
          </button>
          <button onClick={() => reorderLayer(layer.id, -1)} disabled={index <= 0} title="Move down" className={iconBtn}>
            <Icon name="arrow_downward" className="text-base" />
          </button>
          <button onClick={() => duplicateLayer(layer.id)} title="Duplicate layer" className={iconBtn}>
            <Icon name="content_copy" className="text-base" />
          </button>
          {onRequestAiLayer && (
            <button onClick={() => onRequestAiLayer(layer)} title="Edit this layer with AI" className={iconBtn}>
              <Icon name="auto_awesome" className="text-base" />
            </button>
          )}
          <button
            onClick={() => removeLayer(layer.id)}
            title="Delete layer"
            className="w-8 h-8 rounded-lg hover:bg-error-container hover:text-on-error-container flex items-center justify-center text-on-surface-variant"
          >
            <Icon name="delete" className="text-base" />
          </button>
        </div>
      )}
    </div>
  );
}
