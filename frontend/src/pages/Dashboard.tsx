import { useEffect, useState } from 'react';
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
  const [refreshKey, setRefreshKey] = useState(0);

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
    api.listProjects({ page, limit: PAGE_SIZE, q: query })
      .then((res) => {
        setProjects(res.projects || []);
        setTotal(res.total || 0);
        setPages(res.pagination?.pages || 1);
      })
      .catch(() => {})
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
    } finally {
      setDeleting(false);
      setDeleteId(null);
    }
  };

  const firstName = user?.display_name?.split(' ')[0] || 'there';

  return (
    <div className="p-4 sm:p-6 md:p-10 max-w-7xl mx-auto w-full space-y-12">
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
      </section>

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
          <div className="relative w-full sm:w-72">
            <Icon name="search" className="absolute left-3 top-1/2 -translate-y-1/2 text-base text-on-surface-variant pointer-events-none" />
            <input type="search" value={searchInput} onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search designs…"
              className="w-full bg-surface-container-low border border-outline-variant/15 rounded-xl pl-9 pr-9 py-2.5 text-sm focus:ring-2 focus:ring-primary/30 focus:border-primary placeholder:text-outline-variant" />
            {searchInput && (
              <button onClick={() => setSearchInput('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-on-surface-variant hover:text-on-surface w-6 h-6 flex items-center justify-center rounded-full hover:bg-surface-container-high"
                aria-label="Clear search">
                <Icon name="close" className="text-sm" />
              </button>
            )}
          </div>
        </div>

        {loading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {[0, 1, 2].map((i) => (
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
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {projects.map((project) => (
              <div key={project.id} className="relative bg-surface-container-low rounded-3xl overflow-hidden group border border-transparent hover:border-primary-container/20 hover:shadow-xl transition-all">
                <Link to={`/studio/${project.id}`} className="block">
                  <div className="aspect-square relative overflow-hidden bg-surface-container flex items-center justify-center">
                    {project.thumbnail_url
                      ? <img src={project.thumbnail_url} alt={project.title} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-700" />
                      : <Icon name="auto_awesome" className="text-5xl text-outline-variant/30" />}
                    <div className="absolute top-3 left-3 bg-surface/90 backdrop-blur px-3 py-1 rounded-full text-[10px] font-label uppercase font-bold text-on-surface">
                      {project.status}
                    </div>
                    <div className="absolute top-3 right-12 bg-primary-container/90 backdrop-blur px-2 py-0.5 rounded-full text-[10px] font-label uppercase font-bold text-on-primary-container">
                      {project.type}
                    </div>
                  </div>
                  <div className="p-5 bg-surface-container-lowest">
                    <h4 className="font-headline font-bold text-base truncate">{project.title}</h4>
                    <p className="font-label text-[10px] uppercase text-on-surface-variant mt-1">
                      {new Date(project.updated_at || project.created_at).toLocaleDateString()}
                    </p>
                  </div>
                </Link>
                <button onClick={(e) => { e.preventDefault(); setDeleteId(project.id); }}
                  className="absolute top-3 right-3 w-7 h-7 bg-surface/80 backdrop-blur rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-error/10 hover:text-error z-10"
                  aria-label="Delete project">
                  <Icon name="close" className="text-sm" />
                </button>
              </div>
            ))}
          </div>
        )}

        {pages > 1 && (
          <div className="flex items-center justify-center gap-2 mt-8">
            <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1 || loading}
              className="flex items-center gap-1 px-4 py-2 rounded-xl bg-surface-container-low text-sm font-bold disabled:opacity-40 disabled:pointer-events-none hover:bg-surface-container">
              <Icon name="chevron_left" className="text-base" /> Prev
            </button>
            <span className="font-label text-xs uppercase tracking-widest text-on-surface-variant px-3">
              Page {page} of {pages}
            </span>
            <button onClick={() => setPage((p) => Math.min(pages, p + 1))} disabled={page >= pages || loading}
              className="flex items-center gap-1 px-4 py-2 rounded-xl bg-surface-container-low text-sm font-bold disabled:opacity-40 disabled:pointer-events-none hover:bg-surface-container">
              Next <Icon name="chevron_right" className="text-base" />
            </button>
          </div>
        )}
      </section>

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
