import { useEffect, useRef, useState } from 'react';
import { Icon } from '../../components/Icon';
import { EDITOR_FONTS, ensureFontLoaded } from '../lib/text';

// Custom dropdown (native <select> can't reliably render options in their own
// typeface). Fonts load on open so every label previews correctly.
export function FontPicker({ value, onChange }: { value: string; onChange: (family: string) => void }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    for (const f of EDITOR_FONTS) {
      ensureFontLoaded({ fontFamily: f.family, fontSize: 16, fontWeight: 400, italic: false });
    }
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', onDown);
    return () => window.removeEventListener('pointerdown', onDown);
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1 h-9 lg:h-8 px-2.5 rounded-lg bg-surface-container-high hover:bg-surface-container-highest text-xs font-bold max-w-[9rem]"
        title="Font family"
      >
        <span className="truncate" style={{ fontFamily: `"${value}"` }}>{value}</span>
        <Icon name="arrow_drop_down" className="text-base flex-shrink-0" />
      </button>
      {open && (
        <div className="absolute z-30 mt-1 left-0 w-48 max-h-64 overflow-y-auto rounded-xl bg-surface border border-outline-variant/20 shadow-xl py-1">
          {EDITOR_FONTS.map((f) => (
            <button
              key={f.family}
              type="button"
              onClick={() => { onChange(f.family); setOpen(false); }}
              className={`w-full text-left px-3 py-2 text-sm hover:bg-surface-container-high ${f.family === value ? 'text-primary font-bold' : ''}`}
              style={{ fontFamily: `"${f.family}"` }}
            >
              {f.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
