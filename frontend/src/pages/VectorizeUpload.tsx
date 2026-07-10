import { useState } from 'react';
import { Icon } from '../components/Icon';
import { VectorizePanel } from '../components/VectorizePanel';
import { usePageTitle } from '../hooks/usePageTitle';

// Upload-and-vectorise: load ANY image (no generation needed), AI-enlarge it, and
// trace it to an editable SVG. Reuses the VectorizePanel wholesale — it already
// AI-upscales by default, auto-detects transparency, edits, and downloads.
export function VectorizeUpload() {
  usePageTitle('Vectorise an image');
  const [image, setImage] = useState<{ url: string; name: string } | null>(null);
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);

  // Decode → downscale to <=2048 (keeps memory/data-URL sane; the panel re-caps to
  // 1024 before tracing anyway) → PNG so any transparency is preserved for the
  // vectoriser's alpha / auto-remove-background handling.
  const readImage = (file: File | undefined | null) => {
    setError('');
    if (!file) return;
    if (!file.type.startsWith('image/')) { setError('Please choose an image file (PNG, JPG, WEBP, etc.).'); return; }
    if (file.size > 24 * 1024 * 1024) { setError('That image is too large — max 24 MB.'); return; }
    const img = new Image();
    const objUrl = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(objUrl);
      const maxDim = 2048;
      let w = img.naturalWidth, h = img.naturalHeight;
      if (!w || !h) { setError('Could not read that image.'); return; }
      if (Math.max(w, h) > maxDim) { const s = maxDim / Math.max(w, h); w = Math.round(w * s); h = Math.round(h * s); }
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) { setError('Could not process that image.'); return; }
      ctx.drawImage(img, 0, 0, w, h);
      setImage({ url: canvas.toDataURL('image/png'), name: file.name.replace(/\.[^.]+$/, '').slice(0, 60) || 'image' });
    };
    img.onerror = () => { URL.revokeObjectURL(objUrl); setError('Could not read that image.'); };
    img.src = objUrl;
  };

  return (
    <main className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-16">
      <header className="mb-8 sm:mb-12 text-center">
        <h1 className="font-headline text-3xl sm:text-5xl font-black tracking-tighter text-on-surface mb-3">
          Vectorise an image
        </h1>
        <p className="text-on-surface-variant text-base sm:text-lg max-w-xl mx-auto">
          Upload any logo or image — we'll AI-enlarge it and trace it into a clean, scalable SVG you can recolour, edit, and download. No need to generate a design first.
        </p>
      </header>

      {error && (
        <div className="mb-6 bg-error-container/10 text-error border border-error/20 px-4 py-3 rounded-xl text-sm flex items-center gap-2">
          <Icon name="error" className="text-lg flex-shrink-0" /> {error}
        </div>
      )}

      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); readImage(e.dataTransfer.files?.[0]); }}
        className={`relative border-2 border-dashed rounded-3xl bg-surface-container-lowest transition-colors ${
          dragging ? 'border-primary bg-primary-container/10' : 'border-surface-container-high hover:border-primary/50'
        }`}>
        <label className="flex flex-col items-center justify-center gap-3 py-16 sm:py-20 px-6 cursor-pointer text-on-surface-variant text-center">
          <div className="w-16 h-16 rounded-2xl bg-primary-container/20 flex items-center justify-center">
            <Icon name="polyline" className="text-3xl text-primary" />
          </div>
          <span className="font-headline font-bold text-base text-on-surface">Click to choose an image</span>
          <span className="text-sm">or drag &amp; drop · PNG, JPG, WEBP · max 24&nbsp;MB</span>
          <input type="file" accept="image/*" className="hidden" onChange={(e) => readImage(e.target.files?.[0])} />
        </label>
      </div>

      <div className="mt-8 grid grid-cols-1 sm:grid-cols-3 gap-4">
        {[
          { icon: 'hd', title: 'AI-enlarged', desc: 'Super-resolved before tracing for cleaner edges.' },
          { icon: 'palette', title: 'Editable', desc: 'Recolour or remove whole colours (e.g. the background).' },
          { icon: 'download', title: 'Scalable SVG', desc: 'Download a crisp vector that scales to any size.' },
        ].map((f) => (
          <div key={f.title} className="bg-surface-container-low rounded-2xl p-4 text-center">
            <Icon name={f.icon} className="text-2xl text-primary mb-2" />
            <p className="font-headline font-bold text-sm">{f.title}</p>
            <p className="text-xs text-on-surface-variant mt-1">{f.desc}</p>
          </div>
        ))}
      </div>

      {image && (
        <VectorizePanel imageUrl={image.url} title={image.name} onClose={() => setImage(null)} />
      )}
    </main>
  );
}
