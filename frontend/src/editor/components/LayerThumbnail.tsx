import { memo, useEffect, useRef } from 'react';
import type { Layer } from '../types';
import { getBitmap } from '../bitmapRegistry';
import { getIntrinsicSize } from '../lib/transform';
import { drawTextLayer } from '../lib/compose';

// Small preview of a layer's intrinsic content (no transform). Re-renders when
// the layer's bitmap revision bumps — pixels change outside React otherwise.
export const LayerThumbnail = memo(function LayerThumbnail({ layer, rev }: { layer: Layer; rev: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const size = getIntrinsicSize(layer);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const s = Math.min(canvas.width / size.w, canvas.height / size.h);
    ctx.save();
    ctx.translate((canvas.width - size.w * s) / 2, (canvas.height - size.h * s) / 2);
    ctx.scale(s, s);
    if (layer.type === 'raster') {
      const bitmap = getBitmap(layer.id);
      if (bitmap) ctx.drawImage(bitmap, 0, 0);
    } else {
      drawTextLayer(ctx, layer);
    }
    ctx.restore();
  }, [layer, rev]);

  return (
    <canvas
      ref={canvasRef}
      width={44}
      height={44}
      className="w-11 h-11 rounded-lg canvas-checkerboard border border-outline-variant/20 flex-shrink-0"
    />
  );
});
