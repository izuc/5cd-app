import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { Icon } from '../components/Icon';
import { usePageTitle } from '../hooks/usePageTitle';

interface TypeOption {
  value: string;
  label: string;
  placeholder: string;
  examples: string[];
}

const TYPE_OPTIONS: TypeOption[] = [
  {
    value: 'logo',
    label: 'Logo',
    placeholder: 'A modern coffee shop logo, steaming cup, earth tones, minimalist...',
    examples: [
      'A minimalist coffee cup logo, cream background, vector style',
      'Geometric mountain peak, monoline, deep navy on warm white',
      'Fox illustration, friendly and rounded, two-tone orange',
    ],
  },
  {
    value: 'social',
    label: 'Social Post',
    placeholder: 'Promo post for a sneaker drop, neon palette, urban vibe...',
    examples: [
      'Sneaker drop announcement, neon gradient, bold sans serif',
      'Quote card, calm pastel background, serif typography',
      'Product launch, dark mode, glowing accent on a single object',
    ],
  },
  {
    value: 'banner',
    label: 'Banner',
    placeholder: 'Wide banner for a yoga studio, calm pastel, sunrise...',
    examples: [
      'Yoga studio header, sunrise gradient, soft photography',
      'Conference website banner, abstract waves, primary blue',
      'Restaurant banner, warm earth tones, hand-drawn ingredients',
    ],
  },
  {
    value: 'flyer',
    label: 'Flyer',
    placeholder: 'Concert flyer, bold typography, retro 70s feel...',
    examples: [
      'Concert flyer, bold typography, retro 70s palette',
      'Farmers market flyer, vintage poster, warm cream',
      'Workshop announcement, brutalist black and white grid',
    ],
  },
  {
    value: 'custom',
    label: 'Custom Prompt',
    placeholder: 'Whatever you want — full control over the prompt...',
    examples: [
      'A surreal portrait of a fox astronaut on a moonlit cliff',
      'Editorial magazine cover, big serif title, single hero photo',
      'Isometric scene of a tiny floating island with a lighthouse',
    ],
  },
];

// Trained resolution buckets from the upstream model. Generating at these
// sizes produces sharp text and faithful composition. Going below the
// trained size — especially for designs containing typography — will
// scribble the letter-forms.
const SIZE_OPTIONS = [
  { value: '2048x2048', label: 'Square 1:1 · 2048 (best)', w: 2048, h: 2048 },
  { value: '2368x1760', label: 'Landscape 4:3 · 2368',     w: 2368, h: 1760 },
  { value: '1760x2368', label: 'Portrait 3:4 · 2368',      w: 1760, h: 2368 },
  { value: '2720x1536', label: 'Wide 16:9 · 2720',         w: 2720, h: 1536 },
  { value: '1536x2720', label: 'Tall 9:16 · 2720',         w: 1536, h: 2720 },
  { value: '1024x1024', label: 'Square 1:1 · 1024 (preview, slower text)', w: 1024, h: 1024 },
];

const STEPS = 25; // Infographic (base) variant needs ~25 steps. Drop to 8 once the 8-step Infographic LoRA is merged in.

export function CreateDesign() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  usePageTitle('Create New Design');

  const initialType = TYPE_OPTIONS.find((t) => t.value === searchParams.get('type'))?.value || 'logo';
  const [type, setType] = useState(initialType);
  const [description, setDescription] = useState('');
  const [size, setSize] = useState('2048x2048'); // default to the "best" trained resolution
  const [numConcepts, setNumConcepts] = useState(1);
  const [enhance, setEnhance] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const sizePreset = SIZE_OPTIONS.find((s) => s.value === size) || SIZE_OPTIONS[0];
  const typeOption = TYPE_OPTIONS.find((t) => t.value === type) || TYPE_OPTIONS[0];

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const titleSeed = description.replace(/\s+/g, ' ').trim().slice(0, 60) || `${type} project`;
      const project = await api.createProject({
        type,
        title: titleSeed,
        config: {
          description,
          size,
          numConcepts,
          enhance,
          steps: STEPS,
          width: sizePreset.w,
          height: sizePreset.h,
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
          We'll generate {numConcepts} {numConcepts === 1 ? 'design' : 'concepts'} from your prompt — you can refine after.
        </p>
      </header>

      <form onSubmit={handleSubmit} className="space-y-6">
        {error && (
          <div className="bg-error-container/10 text-error border border-error/20 px-4 py-3 rounded-xl text-sm flex items-center gap-2">
            <Icon name="error" className="text-lg flex-shrink-0" /> {error}
          </div>
        )}

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

        <div className="space-y-2">
          <div className="flex items-baseline justify-between px-1">
            <label className="font-label text-xs uppercase tracking-widest text-on-surface-variant font-bold">Prompt</label>
            <span className={`font-label text-[10px] uppercase tracking-widest ${description.length > 30 ? 'text-on-surface-variant' : 'text-outline-variant'}`}>
              {description.length} chars
            </span>
          </div>
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={4} required disabled={loading}
            className="w-full bg-surface-container-lowest border-2 border-surface-container-high rounded-2xl p-5 focus:ring-2 focus:ring-primary/40 focus:border-primary text-on-surface font-medium placeholder:text-outline-variant transition-all text-base resize-none disabled:opacity-60"
            placeholder={typeOption.placeholder} />
          <div className="flex flex-wrap gap-2 pt-1">
            <span className="font-label text-[10px] uppercase tracking-widest text-on-surface-variant px-1 py-1">Try:</span>
            {typeOption.examples.map((ex) => (
              <button key={ex} type="button" onClick={() => setDescription(ex)}
                className="text-xs text-left px-3 py-1.5 rounded-full bg-surface-container-low hover:bg-surface-container text-on-surface-variant hover:text-on-surface transition-colors max-w-full truncate">
                {ex}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-2">
            <label className="font-label text-xs uppercase tracking-widest text-on-surface-variant font-bold px-1">Size</label>
            <select value={size} onChange={(e) => setSize(e.target.value)}
              className="w-full bg-surface-container-lowest border-2 border-surface-container-high rounded-xl p-3 focus:ring-2 focus:ring-primary/40 focus:border-primary text-sm">
              {SIZE_OPTIONS.map((s) => (
                <option key={s.value} value={s.value}>{s.label}</option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <label className="font-label text-xs uppercase tracking-widest text-on-surface-variant font-bold px-1">Concepts</label>
            <div className="flex gap-1.5">
              {[1, 2, 3, 4].map((n) => (
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

        <label className={`flex items-start gap-3 p-4 rounded-2xl border-2 cursor-pointer transition-all ${
          enhance
            ? 'border-primary bg-primary-container/20'
            : 'border-surface-container-high bg-surface-container-lowest hover:border-outline-variant'
        }`}>
          <input
            type="checkbox"
            checked={enhance}
            onChange={(e) => setEnhance(e.target.checked)}
            className="mt-0.5 h-5 w-5 accent-primary cursor-pointer"
          />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-headline font-bold text-sm text-on-surface">Expand my prompt first</span>
              <Icon name="auto_fix_high" className="text-base text-primary" />
            </div>
            <p className="text-xs text-on-surface-variant mt-0.5">
              The model rewrites your description into a detailed brief before generating. Slower (~10s extra), often sharper composition.
            </p>
          </div>
        </label>

        <button type="submit" disabled={loading || !description.trim()}
          className="w-full bg-primary-container py-4 rounded-2xl font-headline text-lg font-black text-on-primary-container shadow-[0_18px_32px_-12px] shadow-primary-container/40 hover:scale-[1.01] active:scale-95 transition-all flex items-center justify-center gap-3 disabled:opacity-50">
          {loading ? 'Creating…' : `Generate ${numConcepts} ${numConcepts === 1 ? 'Design' : 'Concepts'}`}
          <Icon name="auto_awesome" className="text-xl" />
        </button>

        <p className="text-center text-xs text-on-surface-variant">
          Output will be {sizePreset.w} × {sizePreset.h}.
        </p>
      </form>
    </main>
  );
}
