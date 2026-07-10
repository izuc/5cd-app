import { Icon } from '../../components/Icon';
import type { BatchState } from '../hooks/useAiActions';

// Per-layer status card rendered inside a chat bubble during (and after) an
// "all layers" AI run.
export function AiLayerProgress({
  batch, onRetry, onCancel,
}: {
  batch: BatchState;
  onRetry: (layerId: string) => void;
  onCancel: () => void;
}) {
  const icons: Record<string, { name: string; cls: string }> = {
    queued: { name: 'schedule', cls: 'text-on-surface-variant' },
    done: { name: 'check_circle', cls: 'text-primary' },
    failed: { name: 'error', cls: 'text-error' },
    skipped: { name: 'skip_next', cls: 'text-on-surface-variant' },
  };

  return (
    <div className="space-y-1.5 min-w-[220px]">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-bold">Editing layers…</p>
        {batch.running && (
          <button onClick={onCancel} className="text-[11px] font-bold text-error hover:underline">
            Cancel
          </button>
        )}
      </div>
      {batch.layers.slice().reverse().map((l) => (
        <div key={l.layerId} className="flex items-center gap-2 text-xs" title={l.error}>
          {l.status === 'running' ? (
            <span className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin flex-shrink-0" />
          ) : (
            <Icon name={icons[l.status].name} className={`text-base flex-shrink-0 ${icons[l.status].cls}`} />
          )}
          <span className="truncate flex-1">{l.name}</span>
          {l.status === 'failed' && !batch.running && (
            <button onClick={() => onRetry(l.layerId)} className="text-[11px] font-bold text-primary hover:underline flex-shrink-0">
              Retry
            </button>
          )}
        </div>
      ))}
      {!batch.running && (
        <p className="text-[11px] text-on-surface-variant pt-0.5">
          {batch.layers.some((l) => l.status === 'failed')
            ? 'Some layers failed — retry them individually.'
            : 'Layers recombined automatically. One undo reverts the whole run.'}
        </p>
      )}
    </div>
  );
}
