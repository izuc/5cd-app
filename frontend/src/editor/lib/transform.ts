// Coordinate math between a layer's intrinsic pixel space and document space.
//
// A layer's local space runs (0,0)..(w,h) where w/h is its intrinsic size
// (bitmap pixels for raster, measured text box for text). The Transform maps
// local space to document space: center at (cx,cy), scaled, then rotated.

import type { Layer, Point, Transform } from '../types';
import { measureTextLayer } from './text';

export const deg2rad = (deg: number) => (deg * Math.PI) / 180;

export interface Size {
  w: number;
  h: number;
}

export function getIntrinsicSize(layer: Layer): Size {
  if (layer.type === 'raster') return { w: layer.pixelWidth, h: layer.pixelHeight };
  return measureTextLayer(layer);
}

export function layerToDoc(pt: Point, t: Transform, size: Size): Point {
  const dx = (pt.x - size.w / 2) * t.scaleX;
  const dy = (pt.y - size.h / 2) * t.scaleY;
  const r = deg2rad(t.rotation);
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  return {
    x: t.cx + dx * cos - dy * sin,
    y: t.cy + dx * sin + dy * cos,
  };
}

export function docToLayer(pt: Point, t: Transform, size: Size): Point {
  const r = deg2rad(-t.rotation);
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const ox = pt.x - t.cx;
  const oy = pt.y - t.cy;
  const dx = ox * cos - oy * sin;
  const dy = ox * sin + oy * cos;
  return {
    x: dx / (t.scaleX || 1e-6) + size.w / 2,
    y: dy / (t.scaleY || 1e-6) + size.h / 2,
  };
}

/** The layer's four corners in document space: TL, TR, BR, BL. */
export function orientedCorners(layer: Layer): [Point, Point, Point, Point] {
  const size = getIntrinsicSize(layer);
  const t = layer.transform;
  return [
    layerToDoc({ x: 0, y: 0 }, t, size),
    layerToDoc({ x: size.w, y: 0 }, t, size),
    layerToDoc({ x: size.w, y: size.h }, t, size),
    layerToDoc({ x: 0, y: size.h }, t, size),
  ];
}

/** Topmost visible, unlocked layer whose intrinsic rect contains the point.
 *  Bounding-box test (no per-pixel alpha check) — deliberately simple. */
export function hitTestLayers(docPt: Point, layers: Layer[]): Layer | null {
  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i];
    if (!layer.visible || layer.locked) continue;
    const size = getIntrinsicSize(layer);
    const local = docToLayer(docPt, layer.transform, size);
    if (local.x >= 0 && local.x <= size.w && local.y >= 0 && local.y <= size.h) return layer;
  }
  return null;
}

/** Average absolute scale — used to keep brush width doc-relative on scaled layers. */
export function avgScale(t: Transform): number {
  return (Math.abs(t.scaleX) + Math.abs(t.scaleY)) / 2 || 1;
}

export type HandleId = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

const HANDLE_LOCAL: Record<HandleId, Point> = {
  nw: { x: 0, y: 0 }, n: { x: 0.5, y: 0 }, ne: { x: 1, y: 0 },
  e: { x: 1, y: 0.5 }, se: { x: 1, y: 1 }, s: { x: 0.5, y: 1 },
  sw: { x: 0, y: 1 }, w: { x: 0, y: 0.5 },
};

export function handleDocPositions(layer: Layer): Record<HandleId, Point> {
  const size = getIntrinsicSize(layer);
  const t = layer.transform;
  const out = {} as Record<HandleId, Point>;
  for (const id of Object.keys(HANDLE_LOCAL) as HandleId[]) {
    const u = HANDLE_LOCAL[id];
    out[id] = layerToDoc({ x: u.x * size.w, y: u.y * size.h }, t, size);
  }
  return out;
}

const MIN_DISPLAY_PX = 8; // smallest displayed size in doc px

/** New transform for dragging a scale handle. Works in the layer's unrotated
 *  frame: the handle's opposite point (anchor) stays fixed, the dragged handle
 *  follows the pointer; center = midpoint of anchor and its mirror. */
export function resizeFromHandle(
  start: { transform: Transform; size: Size; handle: HandleId },
  pointerDoc: Point,
  opts: { uniform: boolean },
): Transform {
  const { transform: t0, size, handle } = start;
  const u = HANDLE_LOCAL[handle];
  // Anchor = opposite handle, in local unit coords.
  const au = { x: 1 - u.x, y: 1 - u.y };
  const anchorDoc = layerToDoc({ x: au.x * size.w, y: au.y * size.h }, t0, size);

  // Pointer into the unrotated frame relative to the anchor.
  const r = deg2rad(-t0.rotation);
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const px = pointerDoc.x - anchorDoc.x;
  const py = pointerDoc.y - anchorDoc.y;
  let localDx = px * cos - py * sin; // doc px along the layer's local x-axis
  let localDy = px * sin + py * cos;

  const isCorner = u.x !== 0.5 && u.y !== 0.5;
  const signX = u.x > au.x ? 1 : -1; // direction the handle sits from the anchor
  const signY = u.y > au.y ? 1 : -1;

  let scaleX = t0.scaleX;
  let scaleY = t0.scaleY;
  if (u.x !== 0.5) {
    const disp = Math.max(MIN_DISPLAY_PX, signX * localDx);
    scaleX = (disp / size.w) * Math.sign(t0.scaleX || 1);
  }
  if (u.y !== 0.5) {
    const disp = Math.max(MIN_DISPLAY_PX, signY * localDy);
    scaleY = (disp / size.h) * Math.sign(t0.scaleY || 1);
  }
  if (isCorner && opts.uniform) {
    const fx = Math.abs(scaleX / (t0.scaleX || 1e-6));
    const fy = Math.abs(scaleY / (t0.scaleY || 1e-6));
    const f = Math.max(fx, fy);
    scaleX = t0.scaleX * f;
    scaleY = t0.scaleY * f;
  }

  // Recompute center so the anchor point stays put. The dragged handle's local
  // offset from the anchor (unrotated) under the new scale:
  const newT: Transform = { ...t0, scaleX, scaleY };
  const spanX = (u.x - au.x) * size.w * scaleX; // anchor->handle in unrotated frame
  const spanY = (u.y - au.y) * size.h * scaleY;
  // Center sits at anchor + half the span, rotated back into doc space.
  const rr = deg2rad(t0.rotation);
  const rcos = Math.cos(rr);
  const rsin = Math.sin(rr);
  const hx = spanX / 2;
  const hy = spanY / 2;
  newT.cx = anchorDoc.x + hx * rcos - hy * rsin;
  newT.cy = anchorDoc.y + hx * rsin + hy * rcos;
  return newT;
}

/** Re-measure a text layer and recompute its center so its TOP-LEFT corner
 *  stays at `topLeftDoc` — used when committing inline text edits (the box is
 *  anchored top-left while typing). */
export function measureAndPatch<L extends Layer>(layer: L, topLeftDoc: Point): L {
  const size = getIntrinsicSize(layer);
  const t = layer.transform;
  const hx = (size.w / 2) * t.scaleX;
  const hy = (size.h / 2) * t.scaleY;
  const r = deg2rad(t.rotation);
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  return {
    ...layer,
    transform: {
      ...t,
      cx: topLeftDoc.x + hx * cos - hy * sin,
      cy: topLeftDoc.y + hx * sin + hy * cos,
    },
  };
}

export function rotateFromHandle(
  center: Point,
  startPointer: Point,
  curPointer: Point,
  startRotation: number,
  snap15: boolean,
): number {
  const a0 = Math.atan2(startPointer.y - center.y, startPointer.x - center.x);
  const a1 = Math.atan2(curPointer.y - center.y, curPointer.x - center.x);
  let deg = startRotation + ((a1 - a0) * 180) / Math.PI;
  if (snap15) deg = Math.round(deg / 15) * 15;
  // Normalize to (-180, 180] for tidy display.
  deg = ((deg + 180) % 360 + 360) % 360 - 180;
  return deg;
}
