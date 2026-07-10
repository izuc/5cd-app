import { Icon } from '../../components/Icon';
import type { AiScope } from '../types';
import { useEditorStore } from '../editorStore';

// Segmented scope control above the chat composer: what should the AI edit?
export function AiScopeBar({ disabled }: { disabled?: boolean }) {
  const aiScope = useEditorStore((s) => s.aiScope);
  const setAiScope = useEditorStore((s) => s.setAiScope);
  const selected = useEditorStore((s) => s.layers.find((l) => l.id === s.selectedLayerId) ?? null);
  const layerCount = useEditorStore((s) => s.layers.length);

  const options: { scope: AiScope; label: string; icon: string; title: string; disabled?: boolean }[] = [
    { scope: 'image', label: 'Whole image', icon: 'wallpaper', title: 'Edit the flattened image (saved to versions first)' },
    {
      scope: 'layer',
      label: selected ? `“${selected.name.length > 12 ? selected.name.slice(0, 12) + '…' : selected.name}”` : 'Active layer',
      icon: 'layers',
      title: selected ? `Edit only the layer "${selected.name}"` : 'Select a layer first',
      disabled: !selected,
    },
    { scope: 'all-layers', label: 'All layers', icon: 'stacks', title: 'Edit every paint layer separately, then recombine', disabled: layerCount < 2 },
    { scope: 'new-layer', label: 'New layer', icon: 'auto_awesome', title: 'Generate a new transparent layer from the prompt' },
  ];

  return (
    <div className="flex items-center flex-wrap gap-1 mb-2.5" role="radiogroup" aria-label="AI edit scope">
      {options.map((o) => (
        <button
          key={o.scope}
          type="button"
          role="radio"
          aria-checked={aiScope === o.scope}
          disabled={disabled || o.disabled}
          onClick={() => setAiScope(o.scope)}
          title={o.title}
          className={`flex items-center gap-1 px-2.5 py-1.5 rounded-full text-[11px] font-bold whitespace-nowrap transition-all disabled:opacity-40 ${
            aiScope === o.scope
              ? 'bg-primary-container text-on-primary-container'
              : 'bg-surface-container-high text-on-surface-variant hover:bg-surface-container-highest'
          }`}
        >
          <Icon name={o.icon} className="text-sm" />
          {o.label}
        </button>
      ))}
    </div>
  );
}
