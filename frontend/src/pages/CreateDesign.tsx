import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { Icon } from '../components/Icon';
import { usePageTitle } from '../hooks/usePageTitle';

interface TypeOption {
  value: string;
  label: string;
  placeholder: string;
  examples: { label: string; prompt: string }[];
}

// Example prompts tuned for FLUX.2-klein and verified by rendering + visual
// scoring. Text designs quote a SHORT headline
// (the model paints prompt words onto the image); every prompt names a subject,
// palette, and style. Chips show a short label; the full prompt is applied on click.
const TYPE_OPTIONS: TypeOption[] = [
  {
    value: 'logo',
    label: 'Logo',
    placeholder: 'Flat vector fox head logo, geometric origami facets, centered on cream, burnt orange and charcoal two-tone, minimal and bold',
    examples: [
      { label: 'Origami fox', prompt: 'Flat vector fox head logo, geometric origami facets, centered on cream, burnt orange and charcoal two-tone, minimal and bold' },
      { label: 'Geometric owl', prompt: 'Geometric owl logo from circles and triangles, front-facing and symmetrical, centered on navy, mustard yellow and off-white, flat vector' },
      { label: 'Coffee monogram', prompt: 'Flat vector coffee bean and leaf monogram, leaf curling into a bean, centered on beige, espresso brown and sage green, minimal geometric' },
    ],
  },
  {
    value: 'social',
    label: 'Social Post',
    placeholder: "Square sneaker drop post, one glowing high-top hero center, headline reads 'DROP', dark mode, electric magenta and cyan, halftone glow",
    examples: [
      { label: 'Sneaker drop', prompt: "Neon sneaker drop post, one glowing high-top hero center, headline reads 'DROP', dark background, magenta and cyan, halftone glow, hype energy" },
      { label: 'Quote card', prompt: "Minimal quote card, leaf sprig top corner, large serif text reads 'STAY CALM', solid sage-green background, sand and ivory accents, serene mood" },
      { label: 'Summer sale', prompt: "Summer sale post, bold sun and palm motif center, banner reads 'SALE', retro halftone, sunset orange coral and butter-yellow, playful nostalgic mood" },
    ],
  },
  {
    value: 'banner',
    label: 'Banner',
    placeholder: "Wide cafe hero banner reading 'FRESH', a steaming coffee cup on the right, warm cream and terracotta, hand-drawn line art, soft morning light",
    examples: [
      { label: "Cafe 'FRESH'", prompt: "Wide cafe hero banner reading 'FRESH', a steaming coffee cup on the right, warm cream and terracotta, hand-drawn line art, soft morning light" },
      { label: "Hiker 'EXPLORE'", prompt: "Wide hero banner, lone hiker on a misty ridge, banner reads 'EXPLORE' top-left, teal-and-amber palette, flat vector, empty sky for the headline" },
      { label: "Sneaker 'DROP'", prompt: "Wide minimal product hero, single sneaker on a pedestal, banner reads 'DROP', monochrome grey with one neon-green accent, cinematic dark backdrop" },
    ],
  },
  {
    value: 'flyer',
    label: 'Flyer',
    placeholder: "Vintage travel poster titled 'YOSEMITE', a lone granite peak above pine silhouettes, WPA halftone lithograph, forest green and cream, golden-hour glow",
    examples: [
      { label: 'Travel poster', prompt: "Vintage travel poster titled 'YOSEMITE', lone granite peak above pine silhouettes, WPA halftone lithograph, forest green and cream, golden-hour glow" },
      { label: 'Indie film', prompt: "Indie film poster reading 'LOST', a tiny rowboat adrift on vast geometric waves, minimalist risograph, navy and coral on off-white, lonely cinematic mood" },
      { label: 'Festival poster', prompt: "Music festival poster reading 'SUMMER FEST', an electric guitar erupting into wildflowers, retro 70s screenprint, mustard orange and teal, sunset mood" },
    ],
  },
  {
    value: 'custom',
    label: 'Custom Prompt',
    placeholder: 'Isometric scene of a tiny floating island with a glowing lighthouse, waterfalls spilling off the edges, teal and coral palette, flat vector, soft dusk lighting',
    examples: [
      { label: 'Floating island', prompt: 'Isometric tiny floating island with a glowing lighthouse, waterfalls spilling off the edges, teal and coral palette, flat vector, soft dusk lighting' },
      { label: 'Fox astronaut', prompt: 'Editorial illustration of a lone fox astronaut on a moonlit cliff, gazing at a ringed planet, muted indigo and warm amber, flat vector, cinematic rim lighting' },
      { label: 'Botanical line-art', prompt: 'Line-art botanical of monstera and fern leaves in a terracotta pot, centered, sage green and burnt orange, minimal cream background, soft flat shading' },
    ],
  },
];

// Resolution buckets. FLUX.2-klein is tuned for ~1MP (1024). The Create page filters this list to the active
// engine's cap (from /api/ai-config) so you can't pick a size the model dislikes.
const SIZE_OPTIONS = [
  { value: '2048x2048', label: 'Square 1:1 · 2048 (best)', w: 2048, h: 2048 },
  { value: '2368x1760', label: 'Landscape 4:3 · 2368',     w: 2368, h: 1760 },
  { value: '1760x2368', label: 'Portrait 3:4 · 2368',      w: 1760, h: 2368 },
  { value: '2720x1536', label: 'Wide 16:9 · 2720',         w: 2720, h: 1536 },
  { value: '1536x2720', label: 'Tall 9:16 · 2720',         w: 1536, h: 2720 },
  { value: '1024x1024', label: 'Square 1:1 · 1024',        w: 1024, h: 1024 },
  { value: '1024x768',  label: 'Landscape 4:3 · 1024',     w: 1024, h: 768 },
  { value: '768x1024',  label: 'Portrait 3:4 · 1024',      w: 768,  h: 1024 },
];

const STEPS = 8; // Infographic + 8-step distill LoRA → fast 8-step sampling.

export function CreateDesign() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  usePageTitle('Create New Design');

  const initialType = TYPE_OPTIONS.find((t) => t.value === searchParams.get('type'))?.value || 'logo';
  const [type, setType] = useState(initialType);
  const [description, setDescription] = useState('');
  const [size, setSize] = useState('2048x2048'); // default to the "best" trained resolution
  const [maxSide, setMaxSide] = useState(2048);  // active engine's resolution cap (from /api/ai-config)
  const [steps, setSteps] = useState(STEPS);     // active engine's step count
  const [engineLabel, setEngineLabel] = useState('');
  const [numConcepts, setNumConcepts] = useState(1);
  const [expanding, setExpanding] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [mode, setMode] = useState<'describe' | 'upload'>('describe');
  const [upload, setUpload] = useState<{ name: string; dataUrl: string } | null>(null);
  const [reference, setReference] = useState<{ name: string; dataUrl: string } | null>(null);

  // Adapt the size selector + steps to the active engine (FLUX.2-klein).
  // Falls back silently to the built-in defaults if /ai-config is unavailable.
  useEffect(() => {
    api.aiConfig().then((cfg) => {
      setMaxSide(cfg.max_side);
      setSteps(cfg.steps);
      setEngineLabel(cfg.label);
      const fits = SIZE_OPTIONS.filter((s) => Math.max(s.w, s.h) <= cfg.max_side);
      const pref = fits.find((s) => s.value === cfg.default_size) || fits[0];
      if (pref) setSize(pref.value);
    }).catch(() => { /* keep built-in defaults */ });
  }, []);

  // Read an image, downscale to the model's 2048 sweet spot client-side (keeps the
  // payload well under the server POST limit + fast), flatten transparency, store it.
  const readImage = (file: File | undefined | null, set: (v: { name: string; dataUrl: string } | null) => void) => {
    setError('');
    if (!file) return;
    if (!file.type.startsWith('image/')) { setError('Please choose an image file (PNG, JPG, etc.).'); return; }
    if (file.size > 24 * 1024 * 1024) { setError('That image is too large — max 24 MB.'); return; }
    const img = new Image();
    const objUrl = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(objUrl);
      const maxDim = 2048;
      let w = img.naturalWidth, h = img.naturalHeight;
      if (Math.max(w, h) > maxDim) { const s = maxDim / Math.max(w, h); w = Math.round(w * s); h = Math.round(h * s); }
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) { setError('Could not process that image.'); return; }
      ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h); // flatten transparency onto white
      ctx.drawImage(img, 0, 0, w, h);
      set({ name: file.name, dataUrl: canvas.toDataURL('image/jpeg', 0.92) });
    };
    img.onerror = () => { URL.revokeObjectURL(objUrl); setError('Could not read that image.'); };
    img.src = objUrl;
  };
  const onPickFile = (file: File | undefined | null) => readImage(file, setUpload);

  // "Expand my prompt" — rewrite the short description into a detailed brief via the
  // Qwen3 text encoder and drop it back into the (editable) textarea so it's visible.
  const handleExpand = async () => {
    const p = description.trim();
    if (!p || expanding || loading) return;
    setError('');
    setExpanding(true);
    try {
      const r = await api.expandPrompt(p, type);
      if (r.expanded && r.expanded.trim()) setDescription(r.expanded.trim());
    } catch (err: any) {
      setError(err.message || 'Could not expand the prompt.');
    } finally {
      setExpanding(false);
    }
  };

  const availableSizes = SIZE_OPTIONS.filter((s) => Math.max(s.w, s.h) <= maxSide);
  const sizePreset = availableSizes.find((s) => s.value === size) || availableSizes[0] || SIZE_OPTIONS[0];
  const typeOption = TYPE_OPTIONS.find((t) => t.value === type) || TYPE_OPTIONS[0];

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      if (mode === 'upload') {
        if (!upload) { setError('Please choose an image to upload.'); setLoading(false); return; }
        const upTitle = upload.name.replace(/\.[^.]+$/, '').slice(0, 60) || 'Uploaded design';
        const up = await api.createProject({ type, title: upTitle, config: { description: '', uploadImage: upload.dataUrl, steps } });
        navigate(`/studio/${up.project.id}`);
        return;
      }
      const titleSeed = description.replace(/\s+/g, ' ').trim().slice(0, 60) || `${type} project`;
      const project = await api.createProject({
        type,
        title: titleSeed,
        config: {
          description,
          size,
          numConcepts,
          steps,
          width: sizePreset.w,
          height: sizePreset.h,
          ...(reference ? { referenceImages: [reference.dataUrl] } : {}),
        },
      });
      navigate(`/studio/${project.project.id}`);
    } catch (err: any) {
      setError(err.message || 'Failed to create project');
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-16">
      <header className="mb-8 sm:mb-12 text-center">
        <h1 className="font-headline text-3xl sm:text-5xl font-black tracking-tighter text-on-surface mb-3">
          Describe your design
        </h1>
        <p className="text-on-surface-variant text-base sm:text-lg max-w-xl mx-auto">
          {mode === 'upload'
            ? 'Upload an image to refine and edit with prompts.'
            : "We'll generate concepts from your prompt — you can refine after."}
        </p>
      </header>

      <form onSubmit={handleSubmit} className="space-y-6">
        {error && (
          <div className="bg-error-container/10 text-error border border-error/20 px-4 py-3 rounded-xl text-sm flex items-center gap-2">
            <Icon name="error" className="text-lg flex-shrink-0" /> {error}
          </div>
        )}

        <div className="flex justify-center">
          <div className="inline-flex bg-surface-container-high rounded-full p-1 gap-1">
            {([['describe', 'Describe'], ['upload', 'Upload an image']] as const).map(([m, lbl]) => (
              <button key={m} type="button" onClick={() => { setMode(m); setError(''); }}
                className={`px-4 sm:px-5 py-2 rounded-full font-headline font-bold text-sm transition-all ${
                  mode === m ? 'bg-primary-container text-on-primary-container shadow-sm' : 'text-on-surface-variant hover:text-on-surface'
                }`}>
                {lbl}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap gap-2 justify-center">
          {TYPE_OPTIONS.map((t) => (
            <button key={t.value} type="button" onClick={() => setType(t.value)}
              className={`px-4 sm:px-5 py-2.5 rounded-full font-headline font-bold text-sm transition-all ${
                type === t.value
                  ? 'bg-primary-container text-on-primary-container shadow-sm'
                  : 'bg-surface-container-high text-on-surface-variant hover:bg-surface-container-highest'
              }`}>
              {t.label}
            </button>
          ))}
        </div>

        {mode === 'upload' && (
          <div className="space-y-2">
            <label className="font-label text-xs uppercase tracking-widest text-on-surface-variant font-bold px-1">Your image</label>
            <div
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); onPickFile(e.dataTransfer.files?.[0]); }}
              className="relative border-2 border-dashed border-surface-container-high rounded-2xl bg-surface-container-lowest hover:border-primary/50 transition-colors">
              {upload ? (
                <div className="flex items-center gap-4 p-4">
                  <img src={upload.dataUrl} alt="" className="w-24 h-24 object-contain rounded-xl bg-surface-container" />
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-sm truncate">{upload.name}</p>
                    <p className="text-xs text-on-surface-variant mt-0.5">We'll open it in the editor so you can refine it with prompts.</p>
                    <button type="button" onClick={() => setUpload(null)} className="text-xs text-error mt-2 hover:underline">Remove</button>
                  </div>
                </div>
              ) : (
                <label className="flex flex-col items-center justify-center gap-2 py-12 cursor-pointer text-on-surface-variant">
                  <Icon name="upload" className="text-3xl text-primary" />
                  <span className="font-headline font-bold text-sm">Click to choose an image</span>
                  <span className="text-xs">or drag &amp; drop · PNG, JPG · max 12&nbsp;MB</span>
                  <input type="file" accept="image/*" className="hidden" onChange={(e) => onPickFile(e.target.files?.[0])} />
                </label>
              )}
            </div>
          </div>
        )}

        {mode === 'describe' && (
        <>
        <div className="space-y-2">
          <div className="flex items-center justify-between px-1">
            <label className="font-label text-xs uppercase tracking-widest text-on-surface-variant font-bold">Prompt</label>
            <div className="flex items-center gap-3">
              <button type="button" onClick={handleExpand} disabled={loading || expanding || !description.trim()}
                title="Rewrite your prompt into a detailed brief (AI) — you can edit the result"
                className="flex items-center gap-1 text-xs font-bold text-primary hover:text-primary/80 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
                <Icon name="auto_fix_high" className={`text-sm ${expanding ? 'animate-spin' : ''}`} />
                {expanding ? 'Expanding…' : 'Expand'}
              </button>
              <span className={`font-label text-[10px] uppercase tracking-widest ${description.length > 30 ? 'text-on-surface-variant' : 'text-outline-variant'}`}>
                {description.length} chars
              </span>
            </div>
          </div>
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={4} required disabled={loading}
            className="w-full bg-surface-container-lowest border-2 border-surface-container-high rounded-2xl p-5 focus:ring-2 focus:ring-primary/40 focus:border-primary text-on-surface font-medium placeholder:text-outline-variant transition-all text-base resize-none disabled:opacity-60"
            placeholder={typeOption.placeholder} />
          <div className="flex flex-wrap gap-2 pt-1">
            <span className="font-label text-[10px] uppercase tracking-widest text-on-surface-variant px-1 py-1">Try:</span>
            {typeOption.examples.map((ex) => (
              <button key={ex.label} type="button" onClick={() => setDescription(ex.prompt)} title={ex.prompt}
                className="text-xs text-left px-3 py-1.5 rounded-full bg-surface-container-low hover:bg-surface-container text-on-surface-variant hover:text-on-surface transition-colors">
                {ex.label}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-2">
            <label className="font-label text-xs uppercase tracking-widest text-on-surface-variant font-bold px-1">Size</label>
            <select value={size} onChange={(e) => setSize(e.target.value)}
              className="w-full bg-surface-container-lowest border-2 border-surface-container-high rounded-xl p-3 focus:ring-2 focus:ring-primary/40 focus:border-primary text-sm">
              {availableSizes.map((s) => (
                <option key={s.value} value={s.value}>{s.label}</option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <label className="font-label text-xs uppercase tracking-widest text-on-surface-variant font-bold px-1">Concepts</label>
            <div className="flex gap-1.5">
              {[1, 2, 3, 4, 5].map((n) => (
                <button key={n} type="button" onClick={() => setNumConcepts(n)}
                  className={`flex-1 h-12 rounded-xl font-headline font-bold text-sm transition-all ${
                    numConcepts === n
                      ? 'bg-primary-container text-on-primary-container'
                      : 'bg-surface-container-high text-on-surface-variant hover:bg-surface-container-highest'
                  }`}>{n}</button>
              ))}
            </div>
          </div>
        </div>

        <div className="space-y-2">
          <label className="font-label text-xs uppercase tracking-widest text-on-surface-variant font-bold px-1">Reference image (optional)</label>
          {reference ? (
            <div className="flex items-center gap-3 p-3 rounded-2xl border-2 border-surface-container-high bg-surface-container-lowest">
              <img src={reference.dataUrl} alt="" className="w-14 h-14 object-contain rounded-lg bg-surface-container flex-shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="text-sm truncate">{reference.name}</p>
                <p className="text-xs text-on-surface-variant">Concepts will be nudged toward this image's style &amp; palette.</p>
              </div>
              <button type="button" onClick={() => setReference(null)} className="text-xs text-error hover:underline flex-shrink-0">Remove</button>
            </div>
          ) : (
            <label className="flex items-center gap-2 p-3 rounded-2xl border-2 border-dashed border-surface-container-high bg-surface-container-lowest hover:border-primary/50 cursor-pointer text-on-surface-variant text-sm transition-colors">
              <Icon name="add_photo_alternate" className="text-xl text-primary" />
              <span>Attach an image to guide the style</span>
              <input type="file" accept="image/*" className="hidden" onChange={(e) => readImage(e.target.files?.[0], setReference)} />
            </label>
          )}
        </div>
        </>
        )}

        <button type="submit" disabled={loading || (mode === 'describe' ? !description.trim() : !upload)}
          className="w-full bg-primary-container py-4 rounded-2xl font-headline text-lg font-black text-on-primary-container shadow-[0_18px_32px_-12px] shadow-primary-container/40 hover:scale-[1.01] active:scale-95 transition-all flex items-center justify-center gap-3 disabled:opacity-50">
          {loading ? 'Creating…' : mode === 'upload' ? 'Open in editor' : `Generate ${numConcepts} ${numConcepts === 1 ? 'Design' : 'Concepts'}`}
          <Icon name={mode === 'upload' ? 'edit' : 'auto_awesome'} className="text-xl" />
        </button>

        {mode === 'describe' && (
          <p className="text-center text-xs text-on-surface-variant">
            Output will be {sizePreset.w} × {sizePreset.h}{engineLabel ? ` · ${engineLabel}` : ''}.
          </p>
        )}
      </form>
    </main>
  );
}
