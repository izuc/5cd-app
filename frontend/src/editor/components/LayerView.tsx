import { memo, useEffect, useState, type CSSProperties } from 'react';
import type { Layer, TextLayer } from '../types';
import { getBitmap } from '../bitmapRegistry';
import { getIntrinsicSize } from '../lib/transform';
import { ensureFontLoaded } from '../lib/text';

// One layer inside the stage. The wrapper div carries the transform; for
// raster layers the registry-owned <canvas> is mounted directly (painting
// mutates it in place — React never re-renders for pixel changes), for text
// layers the text renders as styled DOM until flatten rasterizes it.
// pointerEvents is none throughout: hit-testing is manual, in doc coords.
export const LayerView = memo(function LayerView({ layer, hidden }: { layer: Layer; hidden?: boolean }) {
  // Text metrics change once the font file arrives — re-measure then.
  const [, setFontTick] = useState(0);
  const fontKey = layer.type === 'text' ? `${layer.fontFamily}|${layer.fontWeight}|${layer.italic}` : '';
  useEffect(() => {
    if (layer.type !== 'text') return;
    let alive = true;
    ensureFontLoaded(layer).then(() => { if (alive) setFontTick((t) => t + 1); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fontKey]);

  const size = getIntrinsicSize(layer);
  const t = layer.transform;
  const style: CSSProperties = {
    position: 'absolute',
    left: 0,
    top: 0,
    width: size.w,
    height: size.h,
    transform: `translate(${t.cx - size.w / 2}px, ${t.cy - size.h / 2}px) rotate(${t.rotation}deg) scale(${t.scaleX}, ${t.scaleY})`,
    transformOrigin: '50% 50%',
    opacity: layer.opacity,
    display: layer.visible && !hidden ? undefined : 'none',
    pointerEvents: 'none',
  };

  if (layer.type === 'raster') {
    return (
      <div
        style={style}
        ref={(el) => {
          const canvas = getBitmap(layer.id);
          if (el && canvas && canvas.parentElement !== el) el.appendChild(canvas);
        }}
      />
    );
  }
  return <div style={{ ...style, ...textStyle(layer) }}>{layer.text}</div>;
});

function textStyle(layer: TextLayer): CSSProperties {
  return {
    whiteSpace: 'pre',
    fontFamily: `"${layer.fontFamily}"`,
    fontSize: layer.fontSize,
    fontWeight: layer.fontWeight,
    fontStyle: layer.italic ? 'italic' : 'normal',
    color: layer.color,
    textAlign: layer.align,
    lineHeight: layer.lineHeight,
  };
}
