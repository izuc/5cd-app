import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import { SvgVectorEditor } from './SvgVectorEditor';
import { api } from '../api/client';
import { useVectorizer } from '../vectorize/useVectorizer';
import type { ConversionSettings, QualityLevel } from '../vectorize/types';

// The raster source is capped to this long side before tracing; the quality level
// then upscales from here (fast 1x / balanced 2x / high 3x / detailed 4x) so even a
// 1024px generation is traced at higher resolution for crisp curves and text.
const MAX_SOURCE = 1024;
// When AI-enlarging, feed the upscaler the source at up to its own output size —
// downscaling a >1024 upload to 1024 first just throws detail away.
const MAX_SOURCE_AI = 2048;

const QUALITY: { value: QualityLevel; label: string }[] = [
  { value: 'fast', label: 'Fast (1×)' },
  { value: 'balanced', label: 'Balanced (2×)' },
  { value: 'high', label: 'High (3×)' },
  { value: 'detailed', label: 'Detailed (4×)' },
];

function hasTransparency(d: ImageData): boolean {
  const data = d.data;
  for (let i = 3; i < data.length; i += 4) if (data[i] < 255) return true;
  return false;
}

export function VectorizePanel({ imageUrl, title, onClose }: { imageUrl: string; title: string; onClose: () => void }) {
  const { svgContent, progress, error: workerError, processImage } = useVectorizer();
  const [quality, setQuality] = useState<QualityLevel>('high');
  const [colorCount, setColorCount] = useState(24); // metallic/gradient logos band badly below ~24; flat logos collapse extras (merge+consolidation) so it's safe
  const [smoothness, setSmoothness] = useState(5); // higher = smoother curves (below ~3 has little effect)
  const [removeBackground, setRemoveBackground] = useState(false);
  const [aiUpscale, setAiUpscale] = useState(true); // enlarge with AI before tracing by default (cleaner trace)
  const [canUpscale, setCanUpscale] = useState(false);
  const [loadingImg, setLoadingImg] = useState(false);
  const [loadMsg, setLoadMsg] = useState('Loading image…');
  const [err, setErr] = useState('');
  const [working, setWorking] = useState('');   // current (edited) SVG
  const [history, setHistory] = useState<string[]>([]);
  const [future, setFuture] = useState<string[]>([]);  // redo stack
  const cacheRef = useRef<{ key: string; data: ImageData; upscaled: boolean } | null>(null);

  // Draw the source image onto a canvas, optionally capped to maxDim (long side).
  const drawSource = useCallback((maxDim: number) => new Promise<HTMLCanvasElement>((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      let w = img.naturalWidth, h = img.naturalHeight;
      const m = Math.max(w, h);
      if (maxDim && m > maxDim) { const s = maxDim / m; w = Math.round(w * s); h = Math.round(h * s); }
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      if (!ctx) return reject(new Error('Canvas not available.'));
      ctx.drawImage(img, 0, 0, w, h);
      resolve(c);
    };
    img.onerror = () => reject(new Error('Could not load the image.'));
    img.src = imageUrl;
  }), [imageUrl]);

  const canvasToImageData = (c: HTMLCanvasElement) => c.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, c.width, c.height);
  const dataUrlToImageData = (url: string) => new Promise<ImageData>((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      if (!ctx) return reject(new Error('Canvas not available.'));
      ctx.drawImage(img, 0, 0);
      resolve(ctx.getImageData(0, 0, c.width, c.height));
    };
    img.onerror = () => reject(new Error('Could not decode upscaled image.'));
    img.src = url;
  });

  const convert = useCallback(async () => {
    setErr('');
    try {
      setLoadingImg(true);
      let data: ImageData;
      let didUpscale = false;
      const cacheKey = `${imageUrl}|${aiUpscale}`;
      if (cacheRef.current && cacheRef.current.key === cacheKey) {
        data = cacheRef.current.data;
        didUpscale = cacheRef.current.upscaled;
      } else if (aiUpscale) {
        setLoadMsg('AI enlarging…');
        try {
          const srcCanvas = await drawSource(MAX_SOURCE_AI);
          // Payload discipline: a 2048px canvas PNG data URL can exceed the
          // backend's POST limit (~8M), which used to make this request die and
          // silently fall back to the low-res path. JPEG at q0.92 is ~10x smaller
          // and the upscaler cleans its artifacts anyway; PNG only when the source
          // has transparency that must survive the round trip.
          const alpha = hasTransparency(canvasToImageData(srcCanvas));
          let srcUrl = alpha ? srcCanvas.toDataURL('image/png') : srcCanvas.toDataURL('image/jpeg', 0.92);
          if (srcUrl.length > 6_000_000) {
            srcUrl = alpha ? (await drawSource(MAX_SOURCE)).toDataURL('image/png') : srcCanvas.toDataURL('image/jpeg', 0.85);
          }
          const up = await api.upscale(srcUrl, 2048); // 4x model, capped to 2048
          data = await dataUrlToImageData(up.image);
          didUpscale = true;
        } catch (upErr) {
          // Upscaler unavailable — fall back to the original so vectorise still works.
          console.warn('AI upscale failed — tracing at original resolution.', upErr);
          data = canvasToImageData(await drawSource(MAX_SOURCE));
        }
        cacheRef.current = { key: cacheKey, data, upscaled: didUpscale };
      } else {
        setLoadMsg('Loading image…');
        data = canvasToImageData(await drawSource(MAX_SOURCE));
        cacheRef.current = { key: cacheKey, data, upscaled: false };
      }
      setLoadingImg(false);
      const settings: ConversionSettings = {
        colorCount, smoothness, minArea: 20, removeBackground,
        hasTransparentSource: hasTransparency(data),
        selectedColors: new Set<number>(),
        // An AI-enlarged source is already high-res, so cap the engine's label
        // upscale at 2x — full quality on a 2048 source would trace at ~6k (slow).
        qualityLevel: didUpscale && (quality === 'high' || quality === 'detailed') ? 'balanced' : quality,
      };
      processImage(data, settings);
    } catch (e: any) { setLoadingImg(false); setErr(e?.message || 'Vectorise failed.'); }
  }, [aiUpscale, colorCount, smoothness, removeBackground, quality, drawSource, processImage, imageUrl]);

  // Auto-run once on open. Ref-guarded: StrictMode double-invokes mount effects in
  // dev, and the duplicate convert() raced its own AI upscale — the late second
  // result flipped the panel back to "Converting…" long after the first finished.
  const autoRan = useRef(false);
  useEffect(() => { if (!autoRan.current) { autoRan.current = true; convert(); } /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);
  // Show the AI-upscale toggle only if the worker supports it.
  useEffect(() => { api.aiConfig().then((c) => setCanUpscale(!!c.supports_upscale)).catch(() => {}); }, []);

  // A fresh conversion replaces the working copy and clears edit history.
  useEffect(() => { if (svgContent) { setWorking(svgContent); setHistory([]); setFuture([]); } }, [svgContent]);

  // Surface worker-side failures (the worker posts 'error'; otherwise the panel would
  // just sit on "No result yet." with no explanation).
  useEffect(() => { if (workerError) { setErr(workerError); setLoadingImg(false); } }, [workerError]);

  const onEdit = useCallback((next: string) => {
    setHistory((h) => [...h.slice(-49), working]);
    setFuture([]);
    setWorking(next);
  }, [working]);

  const undo = useCallback(() => {
    setHistory((h) => {
      if (!h.length) return h;
      setWorking((cur) => { setFuture((f) => [...f.slice(-49), cur]); return h[h.length - 1]; });
      return h.slice(0, -1);
    });
  }, []);

  const redo = useCallback(() => {
    setFuture((f) => {
      if (!f.length) return f;
      setWorking((cur) => { setHistory((h) => [...h.slice(-49), cur]); return f[f.length - 1]; });
      return f.slice(0, -1);
    });
  }, []);

  // Ctrl/Cmd+Z = undo, Ctrl/Cmd+Shift+Z or Ctrl+Y = redo.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && /^(input|textarea|select)$/i.test(t.tagName)) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo]);

  const download = () => {
    if (!working) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([working], { type: 'image/svg+xml' }));
    a.download = (title || 'design').replace(/[^a-z0-9_-]+/gi, '_').slice(0, 60) + '.svg';
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(a.href);
  };

  const busy = loadingImg || (progress.stage !== 'idle' && progress.stage !== 'complete');
  const sizeKB = working ? Math.max(1, Math.round(working.length / 1024)) : 0;

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-2 sm:p-4" onClick={onClose}>
      <div className="bg-surface rounded-2xl sm:rounded-3xl shadow-2xl w-full max-w-6xl h-[95vh] sm:h-[92vh] overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-4 sm:px-6 py-3.5 border-b border-outline-variant/10">
          <div className="flex items-center gap-2">
            <Icon name="polyline" className="text-primary" />
            <h2 className="font-headline font-black text-lg">Vectorise &amp; edit</h2>
          </div>
          <button onClick={onClose} className="p-2 -mr-2 rounded-full text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high transition-colors" aria-label="Close"><Icon name="close" /></button>
        </div>

        {/* Convert settings bar */}
        <div className="flex flex-wrap items-center gap-3 px-4 sm:px-6 py-2.5 border-b border-outline-variant/10 bg-surface-container-low text-sm">
          <label className="flex items-center gap-1.5">
            <span className="text-xs text-on-surface-variant">Quality</span>
            <select value={quality} onChange={(e) => setQuality(e.target.value as QualityLevel)} disabled={busy}
              className="bg-surface-container-lowest border border-surface-container-high rounded-lg px-2 py-1 text-xs">
              {QUALITY.map((q) => <option key={q.value} value={q.value}>{q.label}</option>)}
            </select>
          </label>
          <label className="flex items-center gap-1.5">
            <span className="text-xs text-on-surface-variant">Colours</span>
            <select value={colorCount} onChange={(e) => setColorCount(Number(e.target.value))} disabled={busy}
              className="bg-surface-container-lowest border border-surface-container-high rounded-lg px-2 py-1 text-xs">
              {[4, 6, 8, 12, 16, 24, 32, 48].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          <label className="flex items-center gap-1.5" title="Higher = smoother curves (less detail)">
            <span className="text-xs text-on-surface-variant">Smoothness</span>
            <input type="range" min={1} max={10} step={1} value={smoothness} onChange={(e) => setSmoothness(Number(e.target.value))} disabled={busy} className="w-24 accent-primary" />
            <span className="text-xs w-4 text-on-surface-variant">{smoothness}</span>
          </label>
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input type="checkbox" checked={removeBackground} onChange={(e) => setRemoveBackground(e.target.checked)} disabled={busy} className="h-4 w-4 accent-primary" />
            <span className="text-xs">Auto-remove background</span>
          </label>
          {canUpscale && (
            <label className="flex items-center gap-1.5 cursor-pointer" title="Super-resolve the image with AI before tracing (cleaner, finer detail)">
              <input type="checkbox" checked={aiUpscale} onChange={(e) => setAiUpscale(e.target.checked)} disabled={busy} className="h-4 w-4 accent-primary" />
              <span className="text-xs">AI upscale</span>
            </label>
          )}
          <button onClick={convert} disabled={busy}
            className="ml-auto flex items-center gap-1.5 bg-surface-container-high px-3 py-1.5 rounded-lg text-xs font-bold hover:bg-surface-container-highest disabled:opacity-50">
            <Icon name="autorenew" className="text-sm" /> {busy ? 'Converting…' : 'Re-trace'}
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 min-h-0 p-3 sm:p-5 overflow-y-auto lg:overflow-hidden">
          {err ? (
            <div className="h-full flex items-center justify-center text-center text-error">
              <div><Icon name="error" className="text-4xl mb-2" /><p className="text-sm">{err}</p></div>
            </div>
          ) : busy ? (
            <div className="h-full flex items-center justify-center">
              <div className="w-full max-w-xs space-y-3 text-center">
                <Icon name="hourglass_empty" className="text-4xl text-primary animate-pulse" />
                <div className="h-2 bg-surface-container-high rounded-full overflow-hidden">
                  <div className="h-full bg-primary transition-all" style={{ width: `${Math.round(progress.progress * 100)}%` }} />
                </div>
                <p className="text-xs text-on-surface-variant">{loadingImg ? loadMsg : progress.message}</p>
              </div>
            </div>
          ) : working ? (
            <SvgVectorEditor svg={working} onChange={onEdit} />
          ) : (
            <div className="h-full flex items-center justify-center text-on-surface-variant text-sm">No result yet.</div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center flex-wrap gap-3 px-4 sm:px-6 py-3 border-t border-outline-variant/10">
          <button onClick={undo} disabled={!history.length || busy}
            className="flex items-center gap-1.5 bg-surface-container-high px-3 py-2 rounded-xl text-xs font-bold hover:bg-surface-container-highest disabled:opacity-40">
            <Icon name="undo" className="text-base" /> Undo
          </button>
          <button onClick={redo} disabled={!future.length || busy}
            className="flex items-center gap-1.5 bg-surface-container-high px-3 py-2 rounded-xl text-xs font-bold hover:bg-surface-container-highest disabled:opacity-40">
            <Icon name="redo" className="text-base" /> Redo
          </button>
          <span className="hidden sm:inline text-xs text-on-surface-variant">Tip: use the colour list to recolour or remove a whole colour (e.g. the background).</span>
          <button onClick={download} disabled={!working || busy}
            className="ml-auto flex items-center gap-2 bg-primary-container text-on-primary-container px-5 py-2.5 rounded-xl font-headline font-black hover:scale-[1.01] active:scale-95 transition-all disabled:opacity-50">
            <Icon name="download" className="text-lg" /> Download SVG{sizeKB ? ` · ${sizeKB} KB` : ''}
          </button>
        </div>
      </div>
    </div>
  );
}
