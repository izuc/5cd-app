import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { Icon } from '../components/Icon';
import { usePageTitle } from '../hooks/usePageTitle';

const TYPE_OPTIONS = [
  { value: 'logo', label: 'Logo', placeholder: 'A modern coffee shop logo, steaming cup, earth tones, minimalist...' },
  { value: 'social', label: 'Social Post', placeholder: 'Promo post for a sneaker drop, neon palette, urban vibe...' },
  { value: 'banner', label: 'Banner', placeholder: 'Wide banner for a yoga studio, calm pastel, sunrise...' },
  { value: 'flyer', label: 'Flyer', placeholder: 'Concert flyer, bold typography, retro 70s feel...' },
  { value: 'custom', label: 'Custom Prompt', placeholder: 'Whatever you want — full control over the prompt...' },
];

const SIZE_OPTIONS = [
  { value: '1024x1024', label: 'Square 1:1 (1024)', w: 1024, h: 1024 },
  { value: '1024x768',  label: 'Landscape 4:3',     w: 1024, h: 768 },
  { value: '768x1024',  label: 'Portrait 3:4',      w: 768,  h: 1024 },
  { value: '1280x720',  label: 'Wide 16:9',         w: 1280, h: 720 },
];

export function CreateDesign() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  usePageTitle('Create New Design');

  const initialType = TYPE_OPTIONS.find((t) => t.value === searchParams.get('type'))?.value || 'logo';
  const [type, setType] = useState(initialType);
  const [description, setDescription] = useState('');
  const [size, setSize] = useState('1024x1024');
  const [steps, setSteps] = useState(25);
  const [numConcepts, setNumConcepts] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const sizePreset = SIZE_OPTIONS.find((s) => s.value === size) || SIZE_OPTIONS[0];

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
          steps,
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

  const placeholder = TYPE_OPTIONS.find((t) => t.value === type)?.placeholder || '';

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
          <label className="font-label text-xs uppercase tracking-widest text-on-surface-variant font-bold px-1">Prompt</label>
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={4} required disabled={loading}
            className="w-full bg-surface-container-lowest border-2 border-surface-container-high rounded-2xl p-5 focus:ring-2 focus:ring-primary/40 focus:border-primary text-on-surface font-medium placeholder:text-outline-variant transition-all text-base resize-none disabled:opacity-60"
            placeholder={placeholder} />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
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
          <div className="space-y-2">
            <label className="font-label text-xs uppercase tracking-widest text-on-surface-variant font-bold px-1">Steps ({steps})</label>
            <input type="range" min={10} max={50} step={1} value={steps} onChange={(e) => setSteps(parseInt(e.target.value))}
              className="w-full h-12 accent-primary" aria-label="Sampling steps" />
          </div>
        </div>

        <button type="submit" disabled={loading || !description.trim()}
          className="w-full bg-primary-container py-5 sm:py-6 rounded-2xl font-headline text-xl sm:text-2xl font-black text-on-primary-container shadow-[0_24px_48px_-12px] shadow-primary-container/40 hover:scale-[1.01] active:scale-95 transition-all flex items-center justify-center gap-4 disabled:opacity-50">
          {loading ? 'Creating...' : `Generate ${numConcepts} ${numConcepts === 1 ? 'Design' : 'Concepts'}`}
          <Icon name="auto_awesome" className="text-2xl sm:text-3xl" />
        </button>

        <p className="text-center text-xs text-on-surface-variant">
          Output will be {sizePreset.w} × {sizePreset.h}, {steps} sampling steps.
        </p>
      </form>
    </main>
  );
}
