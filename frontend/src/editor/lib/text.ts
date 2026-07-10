// Text layer measurement and font loading. Fonts are self-hosted woff2 in
// frontend/public/fonts (see google-fonts.css); more editor families are added
// there in the text-tool milestone.

import type { TextLayer } from '../types';

export interface EditorFont {
  family: string;
  label: string;
}

export const EDITOR_FONTS: EditorFont[] = [
  { family: 'Inter', label: 'Inter' },
  { family: 'Plus Jakarta Sans', label: 'Plus Jakarta Sans' },
  { family: 'Space Grotesk', label: 'Space Grotesk' },
  { family: 'Playfair Display', label: 'Playfair Display' },
  { family: 'Oswald', label: 'Oswald' },
  { family: 'Bebas Neue', label: 'Bebas Neue' },
  { family: 'Pacifico', label: 'Pacifico' },
  { family: 'Caveat', label: 'Caveat' },
  { family: 'Roboto Mono', label: 'Roboto Mono' },
];

export const DEFAULT_FONT = 'Inter';

function cssFont(layer: Pick<TextLayer, 'fontFamily' | 'fontSize' | 'fontWeight' | 'italic'>): string {
  return `${layer.italic ? 'italic ' : ''}${layer.fontWeight} ${layer.fontSize}px "${layer.fontFamily}"`;
}

/** Resolve once the family/weight/style is usable for measure + rasterize.
 *  Never rejects — a missing font just falls back to the browser default. */
export async function ensureFontLoaded(
  layer: Pick<TextLayer, 'fontFamily' | 'fontSize' | 'fontWeight' | 'italic'>,
): Promise<void> {
  try {
    await document.fonts.load(cssFont(layer));
  } catch {
    /* fall back silently */
  }
}

let measureCtx: CanvasRenderingContext2D | null = null;

/** Intrinsic size of a text layer's box in doc px (unscaled). */
export function measureTextLayer(layer: TextLayer): { w: number; h: number } {
  if (!measureCtx) {
    measureCtx = document.createElement('canvas').getContext('2d');
    if (!measureCtx) return { w: 1, h: 1 };
  }
  measureCtx.font = cssFont(layer);
  const lines = (layer.text || ' ').split('\n');
  let w = 0;
  for (const line of lines) {
    w = Math.max(w, measureCtx.measureText(line || ' ').width);
  }
  const h = lines.length * layer.fontSize * layer.lineHeight;
  return { w: Math.max(1, Math.ceil(w)), h: Math.max(1, Math.ceil(h)) };
}

/** Per-line baseline positions used by both DOM preview and canvas rasterization. */
export function textLines(layer: TextLayer): { text: string; x: number; baseline: number }[] {
  const size = measureTextLayer(layer);
  if (!measureCtx) return [];
  measureCtx.font = cssFont(layer);
  const lineH = layer.fontSize * layer.lineHeight;
  // Baseline sits ~0.8em into each line box (close to typical ascent).
  const baselineOffset = layer.fontSize * 0.8 + (lineH - layer.fontSize) / 2;
  return (layer.text || '').split('\n').map((text, i) => {
    const lw = measureCtx!.measureText(text || ' ').width;
    const x = layer.align === 'left' ? 0 : layer.align === 'center' ? (size.w - lw) / 2 : size.w - lw;
    return { text, x, baseline: i * lineH + baselineOffset };
  });
}

export { cssFont };
