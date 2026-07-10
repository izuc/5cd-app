// Layer bitmaps are real <canvas> elements owned by this module-level registry,
// outside React and zustand. LayerView mounts the registry canvas directly into
// the DOM (appendChild), so painting mutates the visible pixels with zero
// copies; React only manages the transform wrapper around it.

const registry = new Map<string, HTMLCanvasElement>();

function styleForMount(canvas: HTMLCanvasElement) {
  // The wrapper div is sized to the intrinsic bitmap size; the canvas fills it.
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.display = 'block';
}

export function ctx2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Could not get 2D canvas context');
  return ctx;
}

export function createBitmap(id: string, width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  styleForMount(canvas);
  registry.set(id, canvas);
  return canvas;
}

export function getBitmap(id: string): HTMLCanvasElement | undefined {
  return registry.get(id);
}

/** Register an existing canvas (e.g. built by bitmapFromImage) as a layer bitmap. */
export function adoptBitmap(id: string, canvas: HTMLCanvasElement): HTMLCanvasElement {
  styleForMount(canvas);
  registry.set(id, canvas);
  return canvas;
}

/** Replace a bitmap's pixels in place (canvas size unchanged). */
export function setBitmapContent(id: string, source: CanvasImageSource) {
  const canvas = registry.get(id);
  if (!canvas) return;
  const ctx = ctx2d(canvas);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
}

/** Unregistered working canvas from any drawable source, optionally downscaled. */
export function bitmapFromImage(
  source: CanvasImageSource & { width: number; height: number },
  maxSide?: number,
): HTMLCanvasElement {
  let w = source.width;
  let h = source.height;
  if (maxSide && Math.max(w, h) > maxSide) {
    const s = maxSide / Math.max(w, h);
    w = Math.round(w * s);
    h = Math.round(h * s);
  }
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, w);
  canvas.height = Math.max(1, h);
  const ctx = ctx2d(canvas);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, w, h);
  return canvas;
}

/** Bare base64 (no data-URL prefix), matching the backend's expected payload. */
export function bitmapToBase64Png(id: string): string | null {
  const canvas = registry.get(id);
  if (!canvas) return null;
  return canvas.toDataURL('image/png').replace(/^data:image\/png;base64,/, '');
}

export function disposeBitmap(id: string) {
  const canvas = registry.get(id);
  if (canvas) {
    canvas.remove(); // detach from any LayerView mount
    registry.delete(id);
  }
}

export function disposeAllBitmaps() {
  for (const id of [...registry.keys()]) disposeBitmap(id);
}
