import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuthStore } from '../store/authStore';
import { api, type Project } from '../api/client';
import { Icon } from '../components/Icon';
import { usePageTitle } from '../hooks/usePageTitle';

const QUICK_ACTIONS = [
  { type: 'logo', label: 'Logo', icon: 'pentagon', bg: 'bg-primary-container', text: 'text-on-primary-container' },
  { type: 'social', label: 'Social Post', icon: 'share', bg: 'bg-secondary-container', text: 'text-on-secondary-container' },
  { type: 'banner', label: 'Banner', icon: 'crop_landscape', bg: 'bg-tertiary-container', text: 'text-on-tertiary-container' },
  { type: 'custom', label: 'Custom Prompt', icon: 'auto_awesome', bg: 'bg-on-surface', text: 'text-surface' },
];

const PAGE_SIZE = 12;

const STATUS_DOT: Record<string, string> = {
  draft: 'bg-outline',
  generating: 'bg-secondary',
  editing: 'bg-primary',
  exported: 'bg-tertiary',
  archived: 'bg-outline-variant',
};

// Build a windowed page list with ellipses (e.g. [1, '…', 4, 5, 6, '…', 12]).
function pageWindow(current: number, total: number): (number | '…')[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const out: (number | '…')[] = [1];
  if (current > 3) out.push('…');
  for (let p = Math.max(2, current - 1); p <= Math.min(total - 1, current + 1); p++) out.push(p);
  if (current < total - 2) out.push('…');
  out.push(total);
  return out;
}

export function Dashboard() {
  const { user } = useAuthStore();
  usePageTitle('My Designs');
  const [projects, setProjects] = useState<Project[]>([]);
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(1);
  const [page, setPage] = useState(1);
  const [searchInput, setSearchInput] = useState('');
  const [query, setQuery] = useState('');
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);

  // Press "/" anywhere to focus search (unless already typing in a field).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Debounce the search box so we don't hit the API on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => {
      setQuery(searchInput.trim());
      setPage(1);
    }, 250);
    return () => clearTimeout(t);
  }, [searchInput]);

  useEffect(() => {
    setLoading(true);
    setError('');
    api.listProjects({ page, limit: PAGE_SIZE, q: query })
      .then((res) => {
        setProjects(res.projects || []);
        setTotal(res.total || 0);
        setPages(res.pagination?.pages || 1);
      })
      .catch((err) => setError(err?.message || 'Could not load your designs.'))
      .finally(() => setLoading(false));
  }, [page, query, refreshKey]);

  const handleDelete = async () => {
    if (!deleteId) return;
    setDeleting(true);
    try {
      await api.deleteProject(deleteId);
      // If this was the last item on the page, step back so we don't show an empty grid.
      if (projects.length === 1 && page > 1) {
        setPage((p) => p - 1);
      } else {
        setRefreshKey((k) => k + 1);
      }
      setDeleteId(null);
    } catch (err: any) {
      setError(err?.message || 'Failed to delete project.');
      setDeleteId(null);
    } finally {
      setDeleting(false);
    }
  };

  const firstName = user?.display_name?.split(' ')[0] || 'there';
  const hasProjects = total > 0 || loading;

  // For first-time users (zero projects), Quick Actions take the spotlight at the top.
  const quickActionsHero = !loading && total === 0 && !query;

  return (
    <div className="p-4 sm:p-6 md:p-10 max-w-7xl mx-auto w-full space-y-10">
      {quickActionsHero && (
        <section>
          <h2 className="font-headline text-3xl sm:text-4xl font-extrabold tracking-tight text-on-surface mb-2">
            Ready to create, {firstName}?
          </h2>
          <p className="text-on-surface-variant max-w-lg mb-8">Pick a starting point — one prompt, one polished design.</p>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 sm:gap-4">
            {QUICK_ACTIONS.map((action) => (
              <Link key={action.type} to={`/create?type=${action.type}`}
                className={`group relative ${action.bg} p-5 sm:p-6 rounded-[1.5rem] sm:rounded-[2rem] overflow-hidden hover:scale-[1.02] transition-transform`}>
                <div className="absolute -right-4 -bottom-4 opacity-10 group-hover:scale-110 transition-transform">
                  <Icon name={action.icon} filled className={`text-[6rem] sm:text-[8rem] ${action.text}`} />
                </div>
                <Icon name="add_circle" className={`${action.text} mb-8 sm:mb-12 text-2xl sm:text-3xl`} />
                <h3 className={`font-headline font-extrabold ${action.text} text-lg sm:text-xl leading-tight`}>
                  Start a<br />{action.label}
                </h3>
              </Link>
            ))}
          </div>
          <Link to="/vectorize" className="mt-6 inline-flex items-center gap-2 text-sm font-bold text-primary hover:underline">
            <Icon name="polyline" className="text-base" /> Already have a logo or image? Vectorise it to a scalable SVG
            <Icon name="arrow_forward" className="text-base" />
          </Link>
        </section>
      )}

      <section>
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-6">
          <div className="flex items-baseline gap-3">
            <h2 className="font-headline text-2xl font-bold tracking-tight">My Designs</h2>
            {!loading && total > 0 && (
              <span className="font-label text-xs uppercase tracking-widest text-on-surface-variant">
                {total} {total === 1 ? 'design' : 'designs'}
              </span>
            )}
          </div>
          <div className="relative w-full sm:w-80">
            <Icon name="search" className="absolute left-3 top-1/2 -translate-y-1/2 text-base text-on-surface-variant pointer-events-none" />
            <input ref={searchRef} type="text" value={searchInput} onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search designs…"
              className="w-full bg-surface-container-low border border-outline-variant/15 rounded-xl pl-9 pr-16 py-2.5 text-sm focus:ring-2 focus:ring-primary/30 focus:border-primary placeholder:text-outline-variant" />
            {searchInput ? (
              <button onClick={() => setSearchInput('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-on-surface-variant hover:text-on-surface w-6 h-6 flex items-center justify-center rounded-full hover:bg-surface-container-high"
                aria-label="Clear search">
                <Icon name="close" className="text-sm" />
              </button>
            ) : (
              <kbd className="hidden sm:flex absolute right-2 top-1/2 -translate-y-1/2 h-6 px-2 items-center font-label text-[10px] font-bold text-on-surface-variant bg-surface-container-high rounded-md border border-outline-variant/20">
                /
              </kbd>
            )}
          </div>
        </div>

        {error && (
          <div className="bg-error-container/10 text-error border border-error/20 px-4 py-3 rounded-xl text-sm flex items-center gap-2 mb-6">
            <Icon name="error" /> {error}
          </div>
        )}

        {loading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="bg-surface-container-low rounded-3xl overflow-hidden animate-pulse">
                <div className="aspect-square bg-surface-container" />
                <div className="p-5 space-y-2">
                  <div className="h-4 bg-surface-container rounded w-2/3" />
                  <div className="h-3 bg-surface-container rounded w-1/3" />
                </div>
              </div>
            ))}
          </div>
        ) : projects.length === 0 ? (
          query ? (
            <div className="bg-surface-container-low rounded-3xl p-12 text-center">
              <Icon name="search_off" className="text-6xl text-outline-variant mb-4" />
              <h3 className="font-headline font-bold text-lg mb-2">No matches for “{query}”</h3>
              <p className="text-on-surface-variant mb-6">Try a different search term.</p>
              <button onClick={() => setSearchInput('')}
                className="inline-flex items-center gap-2 bg-surface-container-high px-6 py-3 rounded-xl font-headline font-bold">
                <Icon name="close" /> Clear search
              </button>
            </div>
          ) : (
            <div className="bg-surface-container-low rounded-3xl p-12 text-center">
              <Icon name="folder_open" className="text-6xl text-outline-variant mb-4" />
              <h3 className="font-headline font-bold text-lg mb-2">No designs yet</h3>
              <p className="text-on-surface-variant mb-6">Pick a starting point above to begin.</p>
              <Link to="/create" className="inline-flex items-center gap-2 bg-primary-container text-on-primary-container px-6 py-3 rounded-xl font-headline font-bold">
                <Icon name="add" /> New Design
              </Link>
            </div>
          )
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
            {projects.map((project) => (
              <div key={project.id} className="relative bg-surface-container-lowest rounded-3xl overflow-hidden group border border-outline-variant/5 hover:border-primary-container/40 hover:shadow-xl transition-all">
                <Link to={`/studio/${project.id}`} className="block">
                  <div className="aspect-square relative overflow-hidden canvas-checkerboard flex items-center justify-center">
                    {project.thumbnail_url
                      ? <img src={project.thumbnail_url} alt={project.title} className="w-full h-full object-contain group-hover:scale-[1.03] transition-transform duration-700" />
                      : <Icon name="auto_awesome" className="text-5xl text-outline-variant/30" />}
                  </div>
                  <div className="p-5">
                    <h4 className="font-headline font-bold text-base truncate">{project.title}</h4>
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-2 text-on-surface-variant">
                      <span className={`w-1.5 h-1.5 rounded-full ${STATUS_DOT[project.status] || 'bg-outline'}`} aria-hidden="true" />
                      <span className="font-label text-[10px] uppercase tracking-widest">{project.status}</span>
                      <span className="text-outline-variant" aria-hidden="true">·</span>
                      <span className="font-label text-[10px] uppercase tracking-widest capitalize">{project.type}</span>
                      <span className="text-outline-variant" aria-hidden="true">·</span>
                      <span className="font-label text-[10px] uppercase tracking-widest">
                        {new Date(project.updated_at || project.created_at).toLocaleDateString()}
                      </span>
                    </div>
                  </div>
                </Link>
                <button onClick={(e) => { e.preventDefault(); setDeleteId(project.id); }}
                  className="absolute top-3 right-3 w-8 h-8 bg-surface/90 backdrop-blur rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-error/10 hover:text-error z-10 shadow-sm"
                  aria-label={`Delete ${project.title}`}>
                  <Icon name="close" className="text-sm" />
                </button>
              </div>
            ))}
          </div>
        )}

        {pages > 1 && (
          <nav aria-label="Pagination" className="flex items-center justify-center gap-1 mt-10">
            <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1 || loading}
              className="w-10 h-10 flex items-center justify-center rounded-xl bg-surface-container-low disabled:opacity-30 disabled:pointer-events-none hover:bg-surface-container"
              aria-label="Previous page">
              <Icon name="chevron_left" />
            </button>
            {pageWindow(page, pages).map((p, i) =>
              p === '…' ? (
                <span key={`gap-${i}`} className="w-10 h-10 flex items-center justify-center text-on-surface-variant font-label">…</span>
              ) : (
                <button key={p} onClick={() => setPage(p)} disabled={loading}
                  aria-current={p === page ? 'page' : undefined}
                  className={`w-10 h-10 flex items-center justify-center rounded-xl font-headline font-bold text-sm transition-colors ${
                    p === page
                      ? 'bg-on-surface text-surface'
                      : 'bg-surface-container-low text-on-surface hover:bg-surface-container'
                  }`}>
                  {p}
                </button>
              )
            )}
            <button onClick={() => setPage((p) => Math.min(pages, p + 1))} disabled={page >= pages || loading}
              className="w-10 h-10 flex items-center justify-center rounded-xl bg-surface-container-low disabled:opacity-30 disabled:pointer-events-none hover:bg-surface-container"
              aria-label="Next page">
              <Icon name="chevron_right" />
            </button>
          </nav>
        )}
      </section>

      {!quickActionsHero && hasProjects && (
        <section className="border-t border-outline-variant/15 pt-8">
          <p className="font-label text-[10px] uppercase tracking-widest text-on-surface-variant mb-4">Start something new</p>
          <div className="flex flex-wrap gap-2">
            {QUICK_ACTIONS.map((action) => (
              <Link key={action.type} to={`/create?type=${action.type}`}
                className="inline-flex items-center gap-2 bg-surface-container-low hover:bg-surface-container px-4 py-2.5 rounded-xl text-sm font-headline font-bold transition-colors">
                <Icon name={action.icon} className="text-base text-primary" />
                {action.label}
              </Link>
            ))}
            <Link to="/vectorize"
              className="inline-flex items-center gap-2 bg-primary-container/20 hover:bg-primary-container/30 px-4 py-2.5 rounded-xl text-sm font-headline font-bold transition-colors">
              <Icon name="polyline" className="text-base text-primary" />
              Vectorise an image
            </Link>
          </div>
        </section>
      )}

      {deleteId && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/30 backdrop-blur-sm" onClick={() => setDeleteId(null)}>
          <div className="bg-surface-container-lowest rounded-2xl shadow-2xl w-full max-w-sm mx-4 p-6 space-y-4" onClick={(e) => e.stopPropagation()}>
            <h3 className="font-headline font-bold text-lg">Delete project?</h3>
            <p className="text-on-surface-variant text-sm">This will archive the project and its generated assets.</p>
            <div className="flex gap-3 justify-end">
              <button onClick={() => setDeleteId(null)} className="px-5 py-2.5 rounded-xl font-headline font-bold text-sm bg-surface-container-high">Cancel</button>
              <button onClick={handleDelete} disabled={deleting} className="px-5 py-2.5 rounded-xl font-headline font-bold text-sm bg-error text-on-error disabled:opacity-50">
                {deleting ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="pb-8 sm:pb-20" />
    </div>
  );
}
