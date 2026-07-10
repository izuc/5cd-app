// Paint gesture engine. A StrokeSession owns one brush/eraser/shape gesture on
// a raster layer:
//  - base snapshot: the layer's pixels at gesture start (offscreen)
//  - stroke buffer: just this gesture's marks (offscreen)
// Every frame the live canvas is recomposed base+buffer, which gives correct
// flat-opacity strokes (no self-overlap darkening) and free eraser semantics
// (buffer applied with destination-out). commit() extracts before/after pixels
// for the dirty rect only, for cheap undo entries.

import type { Point, RasterLayer, RectSnapshot } from '../types';
import { ctx2d, getBitmap } from '../bitmapRegistry';
import { avgScale, docToLayer } from './transform';

export type StrokeMode = 'brush' | 'eraser' | 'line' | 'rect' | 'ellipse';

export interface StrokeOptions {
  mode: StrokeMode;
  color: string;        // ignored by eraser
  size: number;         // brush diameter / shape stroke width, in DOC px
  opacity: number;      // 0..1 (brush only; eraser & shapes use 1)
  fill: string | null;  // shapes only
}

export class StrokeSession {
  private layer: RasterLayer;
  private opts: StrokeOptions;
  private live: HTMLCanvasElement;
  private base: HTMLCanvasElement;
  private buffer: HTMLCanvasElement;
  private bufCtx: CanvasRenderingContext2D;
  private localWidth: number; // stroke width in layer-local px
  private last: Point | null = null;
  private prevMid: Point | null = null;
  private origin: Point | null = null; // shapes: drag start (local)
  private minX = Infinity; private minY = Infinity;
  private maxX = -Infinity; private maxY = -Infinity;
  private any = false;

  constructor(layer: RasterLayer, opts: StrokeOptions) {
    const live = getBitmap(layer.id);
    if (!live) throw new Error('Layer bitmap missing');
    this.layer = layer;
    this.opts = opts;
    this.live = live;
    this.base = document.createElement('canvas');
    this.base.width = live.width;
    this.base.height = live.height;
    ctx2d(this.base).drawImage(live, 0, 0);
    this.buffer = document.createElement('canvas');
    this.buffer.width = live.width;
    this.buffer.height = live.height;
    this.bufCtx = ctx2d(this.buffer);
    // Brush size is doc-relative; a scaled layer needs a compensated local width.
    this.localWidth = Math.max(0.5, opts.size / avgScale(layer.transform));
    this.bufCtx.lineCap = 'round';
    this.bufCtx.lineJoin = 'round';
    this.bufCtx.strokeStyle = opts.mode === 'eraser' ? '#000' : opts.color;
    this.bufCtx.lineWidth = this.localWidth;
  }

  private track(pt: Point, pad: number) {
    this.minX = Math.min(this.minX, pt.x - pad);
    this.minY = Math.min(this.minY, pt.y - pad);
    this.maxX = Math.max(this.maxX, pt.x + pad);
    this.maxY = Math.max(this.maxY, pt.y + pad);
    this.any = true;
  }

  private toLocal(docPt: Point): Point {
    return docToLayer(docPt, this.layer.transform, { w: this.layer.pixelWidth, h: this.layer.pixelHeight });
  }

  /** Feed a pointer event (uses coalesced events for smooth fast strokes). */
  addPointerEvent(e: PointerEvent, screenToDoc: (x: number, y: number) => Point, shiftKey: boolean) {
    const events = typeof e.getCoalescedEvents === 'function' && e.getCoalescedEvents().length
      ? e.getCoalescedEvents()
      : [e];
    for (const ev of events) {
      this.addPoint(this.toLocal(screenToDoc(ev.clientX, ev.clientY)), shiftKey);
    }
    this.recompose();
  }

  addPoint(local: Point, shiftKey: boolean) {
    const pad = this.localWidth / 2 + 2;
    const { mode } = this.opts;

    if (mode === 'brush' || mode === 'eraser') {
      if (!this.last) {
        // Dot for a click without movement.
        this.bufCtx.beginPath();
        this.bufCtx.arc(local.x, local.y, this.localWidth / 2, 0, Math.PI * 2);
        this.bufCtx.fillStyle = this.bufCtx.strokeStyle as string;
        this.bufCtx.fill();
        this.last = local;
        this.prevMid = local;
        this.track(local, pad);
        return;
      }
      // Midpoint-quadratic smoothing: curve from the previous midpoint through
      // the previous point to the current midpoint.
      const mid = { x: (this.last.x + local.x) / 2, y: (this.last.y + local.y) / 2 };
      this.bufCtx.beginPath();
      this.bufCtx.moveTo(this.prevMid!.x, this.prevMid!.y);
      this.bufCtx.quadraticCurveTo(this.last.x, this.last.y, mid.x, mid.y);
      this.bufCtx.stroke();
      this.track(this.last, pad);
      this.track(local, pad);
      this.last = local;
      this.prevMid = mid;
      return;
    }

    // Shapes: redraw the whole buffer origin -> current each move.
    if (!this.origin) {
      this.origin = local;
      this.track(local, pad);
      return;
    }
    let { x, y } = local;
    const o = this.origin;
    if (shiftKey) {
      if (mode === 'line') {
        // Snap to 45° increments.
        const dx = x - o.x;
        const dy = y - o.y;
        const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
        const len = Math.hypot(dx, dy);
        x = o.x + Math.cos(ang) * len;
        y = o.y + Math.sin(ang) * len;
      } else {
        // Square / circle.
        const side = Math.max(Math.abs(x - o.x), Math.abs(y - o.y));
        x = o.x + Math.sign(x - o.x || 1) * side;
        y = o.y + Math.sign(y - o.y || 1) * side;
      }
    }
    this.bufCtx.clearRect(0, 0, this.buffer.width, this.buffer.height);
    this.bufCtx.beginPath();
    if (mode === 'line') {
      this.bufCtx.moveTo(o.x, o.y);
      this.bufCtx.lineTo(x, y);
      this.bufCtx.stroke();
    } else {
      const rx = Math.min(o.x, x);
      const ry = Math.min(o.y, y);
      const rw = Math.abs(x - o.x);
      const rh = Math.abs(y - o.y);
      if (mode === 'rect') this.bufCtx.rect(rx, ry, rw, rh);
      else this.bufCtx.ellipse(rx + rw / 2, ry + rh / 2, rw / 2, rh / 2, 0, 0, Math.PI * 2);
      if (this.opts.fill) {
        this.bufCtx.fillStyle = this.opts.fill;
        this.bufCtx.fill();
      }
      this.bufCtx.stroke();
    }
    this.track(o, pad);
    this.track({ x, y }, pad);
    this.recompose();
  }

  private recompose() {
    const ctx = ctx2d(this.live);
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, this.live.width, this.live.height);
    ctx.drawImage(this.base, 0, 0);
    if (this.opts.mode === 'eraser') {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.drawImage(this.buffer, 0, 0);
    } else {
      ctx.globalAlpha = this.opts.mode === 'brush' ? this.opts.opacity : 1;
      ctx.drawImage(this.buffer, 0, 0);
    }
    ctx.restore();
  }

  /** Dirty rect (clamped to the canvas), or null if nothing was drawn. */
  private dirtyRect(): { x: number; y: number; w: number; h: number } | null {
    if (!this.any) return null;
    const x = Math.max(0, Math.floor(this.minX));
    const y = Math.max(0, Math.floor(this.minY));
    const w = Math.min(this.live.width, Math.ceil(this.maxX)) - x;
    const h = Math.min(this.live.height, Math.ceil(this.maxY)) - y;
    if (w <= 0 || h <= 0) return null;
    return { x, y, w, h };
  }

  /** Finish the gesture; returns before/after snapshots for the undo entry,
   *  or null if the stroke never touched the canvas. */
  commit(): { before: RectSnapshot; after: RectSnapshot } | null {
    const rect = this.dirtyRect();
    if (!rect) return null;
    const before: RectSnapshot = { x: rect.x, y: rect.y, data: ctx2d(this.base).getImageData(rect.x, rect.y, rect.w, rect.h) };
    const after: RectSnapshot = { x: rect.x, y: rect.y, data: ctx2d(this.live).getImageData(rect.x, rect.y, rect.w, rect.h) };
    return { before, after };
  }

  /** Abandon the gesture and restore the layer's pixels. */
  cancel() {
    const ctx = ctx2d(this.live);
    ctx.clearRect(0, 0, this.live.width, this.live.height);
    ctx.drawImage(this.base, 0, 0);
  }
}
