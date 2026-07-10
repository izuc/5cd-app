// Flattening, rasterization and image helpers.

import type { EditorDoc, Layer, RectSnapshot, TextLayer } from '../types';
import { getBitmap, ctx2d, setBitmapContent } from '../bitmapRegistry';
import { deg2rad, getIntrinsicSize } from './transform';
import { cssFont, ensureFontLoaded, textLines } from './text';

export function loadImageEl(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous'; // same-origin in practice; keeps canvases untainted
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to load image'));
    img.src = url;
  });
}

/** Draw one layer onto a document-space context, honoring its transform + opacity. */
export function renderLayerToCtx(ctx: CanvasRenderingContext2D, layer: Layer) {
  const size = getIntrinsicSize(layer);
  const t = layer.transform;
  ctx.save();
  ctx.globalAlpha = layer.opacity;
  ctx.translate(t.cx, t.cy);
  ctx.rotate(deg2rad(t.rotation));
  ctx.scale(t.scaleX, t.scaleY);
  ctx.translate(-size.w / 2, -size.h / 2);
  if (layer.type === 'raster') {
    const bitmap = getBitmap(layer.id);
    if (bitmap) ctx.drawImage(bitmap, 0, 0);
  } else {
    drawTextLayer(ctx, layer);
  }
  ctx.restore();
}

/** Draw a text layer's content at intrinsic size, origin (0,0). Exported for
 *  thumbnails; flatten uses it via renderLayerToCtx. */
export function drawTextLayer(ctx: CanvasRenderingContext2D, layer: TextLayer) {
  ctx.font = cssFont(layer);
  ctx.fillStyle = layer.color;
  ctx.textBaseline = 'alphabetic';
  for (const line of textLines(layer)) {
    if (line.text) ctx.fillText(line.text, line.x, line.baseline);
  }
}

/** Composite all visible layers at document resolution. */
export async function flattenDoc(
  doc: EditorDoc,
  layers: Layer[],
  opts?: { background?: 'white' | 'transparent' },
): Promise<HTMLCanvasElement> {
  for (const layer of layers) {
    if (layer.type === 'text' && layer.visible) await ensureFontLoaded(layer);
  }
  const canvas = document.createElement('canvas');
  canvas.width = doc.width;
  canvas.height = doc.height;
  const ctx = ctx2d(canvas);
  if (opts?.background !== 'transparent') {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, doc.width, doc.height);
  }
  for (const layer of layers) {
    if (layer.visible) renderLayerToCtx(ctx, layer);
  }
  return canvas;
}

/** A text layer's pixels at intrinsic size (unscaled) — for AI round-trips
 *  and text→raster conversion. */
export async function rasterizeTextLayer(layer: TextLayer): Promise<HTMLCanvasElement> {
  await ensureFontLoaded(layer);
  const size = getIntrinsicSize(layer);
  const canvas = document.createElement('canvas');
  canvas.width = size.w;
  canvas.height = size.h;
  drawTextLayer(ctx2d(canvas), layer);
  return canvas;
}

export function resampleToSize(
  source: CanvasImageSource & { width: number; height: number },
  w: number,
  h: number,
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w));
  canvas.height = Math.max(1, Math.round(h));
  const ctx = ctx2d(canvas);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/** A layer's pixels as bare base64 PNG (intrinsic size), for AI submission. */
export async function layerToPngBase64(layer: Layer): Promise<string | null> {
  const canvas = layer.type === 'raster' ? getBitmap(layer.id) : await rasterizeTextLayer(layer);
  if (!canvas) return null;
  return canvas.toDataURL('image/png').replace(/^data:image\/png;base64,/, '');
}

/** True if any pixel is non-opaque (sampled; good enough to pick the
 *  transparent-edit path for AI round-trips). */
export function bitmapHasAlpha(canvas: HTMLCanvasElement): boolean {
  const data = ctx2d(canvas).getImageData(0, 0, canvas.width, canvas.height).data;
  const step = Math.max(1, Math.floor(Math.max(canvas.width, canvas.height) / 256));
  for (let y = 0; y < canvas.height; y += step) {
    const row = y * canvas.width * 4;
    for (let x = 0; x < canvas.width; x += step) {
      if (data[row + x * 4 + 3] < 250) return true;
    }
  }
  return false;
}

export function normalizeBase64Png(b64: string): string {
  return b64.startsWith('data:') ? b64 : `data:image/png;base64,${b64}`;
}

/** Decode a (bare or data-URL) base64 PNG into an HTMLImageElement. */
export function decodeBase64Image(b64: string): Promise<HTMLImageElement> {
  return loadImageEl(normalizeBase64Png(b64));
}

/** Write an AI result's pixels onto a raster layer (resampled from the
 *  worker's ≤1024px output back to the layer's stored size) and return the
 *  before/after snapshots — the caller decides whether to commit them as a
 *  single entry or fold them into a batch. */
export async function applyAiResultPixels(
  layerId: string,
  b64: string,
): Promise<{ before: RectSnapshot; after: RectSnapshot } | null> {
  const canvas = getBitmap(layerId);
  if (!canvas) return null;
  const img = await decodeBase64Image(b64);
  const before: RectSnapshot = { x: 0, y: 0, data: ctx2d(canvas).getImageData(0, 0, canvas.width, canvas.height) };
  setBitmapContent(layerId, resampleToSize(img, canvas.width, canvas.height));
  const after: RectSnapshot = { x: 0, y: 0, data: ctx2d(canvas).getImageData(0, 0, canvas.width, canvas.height) };
  return { before, after };
}
