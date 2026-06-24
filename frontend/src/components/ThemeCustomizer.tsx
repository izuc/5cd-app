import { useState } from 'react';
import { useTheme } from '../hooks/useTheme';
import { THEME_PRESETS } from '../lib/theme';
import { Icon } from './Icon';

export function ThemeCustomizer({ onClose }: { onClose: () => void }) {
  const { themeColor, setThemeColor } = useTheme();
  const [customHex, setCustomHex] = useState(themeColor);

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/30 backdrop-blur-sm p-4 overflow-y-auto" onClick={onClose}>
      <div className="bg-surface-container-lowest rounded-3xl shadow-2xl w-full max-w-md p-6 sm:p-8 space-y-6 max-h-[90vh] overflow-y-auto my-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="font-headline text-xl font-extrabold tracking-tight">Customize Theme</h2>
          <button onClick={onClose} className="p-2 rounded-full hover:bg-surface-container-high transition-colors" aria-label="Close">
            <Icon name="close" />
          </button>
        </div>

        <p className="text-on-surface-variant text-sm">Choose an accent color for your interface.</p>

        <div className="space-y-3">
          <label className="font-label text-xs uppercase tracking-widest text-on-surface-variant font-bold">Presets</label>
          <div className="grid grid-cols-3 gap-3">
            {Object.entries(THEME_PRESETS).map(([key, preset]) => (
              <button
                key={key}
                onClick={() => { setThemeColor(preset.hex); setCustomHex(preset.hex); }}
                className={`flex items-center gap-3 p-3 rounded-xl border-2 transition-all ${
                  themeColor === preset.hex
                    ? 'border-primary bg-primary-container/20'
                    : 'border-transparent bg-surface-container-low hover:bg-surface-container-high'
                }`}
              >
                <div className="w-6 h-6 rounded-full shadow-sm flex-shrink-0" style={{ backgroundColor: preset.hex }} />
                <span className="font-label text-xs font-bold">{preset.label}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-3">
          <label className="font-label text-xs uppercase tracking-widest text-on-surface-variant font-bold">Custom Color</label>
          <div className="flex gap-3">
            <input type="color" value={customHex} onChange={(e) => setCustomHex(e.target.value)}
              className="w-12 h-12 rounded-xl cursor-pointer border-2 border-surface-container-high"
              aria-label="Pick a color" />
            <div className="flex-1 flex gap-2">
              <input type="text" value={customHex} onChange={(e) => setCustomHex(e.target.value)}
                placeholder="#059669" maxLength={7}
                className="flex-1 bg-surface-container-low border-none rounded-xl px-4 py-3 focus:ring-2 focus:ring-primary/40 font-label text-sm"
                aria-label="Hex color code" />
              <button onClick={() => { if (/^#[0-9a-fA-F]{6}$/.test(customHex)) setThemeColor(customHex); }}
                className="bg-primary text-on-primary px-5 py-3 rounded-xl font-headline font-bold text-sm hover:opacity-90 transition-opacity">
                Apply
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
