import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, type Project } from '../api/client';
import { useAuthStore } from '../store/authStore';
import { Icon } from '../components/Icon';
import { usePageTitle } from '../hooks/usePageTitle';

const EXPORT_OPTIONS = [
  { format: 'png', label: 'PNG', desc: 'Web-ready raster.', icon: 'image', credits: 0, creditLabel: 'FREE' },
  { format: 'jpg', label: 'JPG', desc: 'Compressed, smaller file.', icon: 'photo', credits: 0, creditLabel: 'FREE' },
  { format: 'transparent_png', label: 'Transparent PNG', desc: 'White-background chroma-keyed.', icon: 'layers', credits: 1, creditLabel: '1 Credit' },
  { format: 'pdf', label: 'PDF', desc: 'Single-page PDF wrapping the image.', icon: 'picture_as_pdf', credits: 2, creditLabel: '2 Credits' },
];

export function ExportCheckout() {
  const { projectId } = useParams<{ projectId: string }>();
  const { user, setCredits } = useAuthStore();
  usePageTitle('Export Design');
  const [project, setProject] = useState<Project | null>(null);
  const [selected, setSelected] = useState('png');
  const [exporting, setExporting] = useState(false);
  const [exportResult, setExportResult] = useState<any>(null);
  const [error, setError] = useState('');

  const selectedOption = EXPORT_OPTIONS.find((o) => o.format === selected)!;

  useEffect(() => {
    if (!projectId) return;
    api.getProject(parseInt(projectId)).then((res) => setProject(res.project))
      .catch((err) => setError(err?.message || 'Could not load this project.'));
  }, [projectId]);

  const handleExport = async () => {
    if (!projectId) return;
    setExporting(true);
    setError('');
    try {
      const res = await api.exportProject(parseInt(projectId), selected);
      setExportResult(res.export);
      if (user && selectedOption.credits > 0) setCredits(user.credits - selectedOption.credits);
    } catch (err: any) {
      setError(err.message || 'Export failed');
    } finally {
      setExporting(false);
    }
  };

  const handleDownload = () => {
    if (!exportResult?.file_url) return;
    const link = document.createElement('a');
    link.href = exportResult.file_url;
    link.download = `${project?.title || 'design'}.${exportResult.format === 'transparent_png' ? 'png' : exportResult.format}`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const previewUrl = project?.chosen_generation?.output_image_url;

  return (
    <main className="max-w-5xl xl:max-w-6xl mx-auto px-4 sm:px-6 pt-8 sm:pt-12 pb-24">
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        <div className="lg:col-span-5">
          <Link to={`/studio/${projectId}`} className="inline-flex items-center gap-2 text-on-surface-variant hover:text-on-surface mb-4 text-sm">
            <Icon name="arrow_back" /> Back to studio
          </Link>
          <div className="bg-surface-container-lowest rounded-2xl p-6 border border-outline-variant/10">
            <h2 className="font-headline text-xl font-bold tracking-tight mb-4">Preview</h2>
            <div className="bg-surface-container-low rounded-xl overflow-hidden flex items-center justify-center min-h-[180px] canvas-checkerboard">
              {previewUrl
                ? <img src={previewUrl} alt="Design preview" className="max-w-full max-h-[420px] object-contain" />
                : <Icon name="hourglass_empty" className="text-5xl text-outline-variant/40" />}
            </div>
            {project && (
              <div className="mt-4 space-y-1">
                <p className="font-headline font-bold">{project.title}</p>
                <p className="text-xs text-on-surface-variant capitalize">{project.type}</p>
              </div>
            )}
          </div>
        </div>

        <div className="lg:col-span-7">
          <h1 className="font-headline text-3xl font-black tracking-tighter mb-6">Choose format</h1>
          {error && (
            <div className="bg-error-container/10 text-error border border-error/20 px-4 py-3 rounded-xl text-sm flex items-center gap-2 mb-4">
              <Icon name="error" /> {error}
            </div>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-6">
            {EXPORT_OPTIONS.map((opt) => {
              const active = selected === opt.format;
              return (
                <button key={opt.format} onClick={() => { setSelected(opt.format); setExportResult(null); setError(''); }}
                  className={`text-left p-4 rounded-2xl border-2 transition-all ${
                    active ? 'border-primary bg-primary-container/20' : 'border-surface-container-high bg-surface-container-lowest hover:bg-surface-container-low'
                  }`}>
                  <div className="flex items-start justify-between mb-2">
                    <Icon name={opt.icon} className="text-2xl text-primary" />
                    <span className={`text-[10px] font-label font-bold px-2 py-0.5 rounded-full ${
                      opt.credits === 0 ? 'bg-primary-container text-on-primary-container' : 'bg-surface-container-high'
                    }`}>{opt.creditLabel}</span>
                  </div>
                  <h3 className="font-headline font-bold text-base">{opt.label}</h3>
                  <p className="text-xs text-on-surface-variant mt-1">{opt.desc}</p>
                </button>
              );
            })}
          </div>

          {exportResult ? (
            <div className="bg-surface-container-lowest rounded-2xl p-6 space-y-4">
              <div className="flex items-center gap-3">
                <Icon name="check_circle" className="text-3xl text-primary" filled />
                <div>
                  <h3 className="font-headline font-bold text-lg">Export ready</h3>
                  <p className="text-sm text-on-surface-variant">Your file is saved to your account.</p>
                </div>
              </div>
              {exportResult.file_url && (exportResult.format === 'png' || exportResult.format === 'jpg' || exportResult.format === 'transparent_png') && (
                <div className="canvas-checkerboard rounded-xl overflow-hidden flex items-center justify-center p-2">
                  <img src={exportResult.file_url} alt="Exported design" className="max-w-full max-h-64 object-contain" />
                </div>
              )}
              <button onClick={handleDownload} className="w-full bg-primary-container text-on-primary-container py-4 rounded-xl font-headline font-bold text-base hover:scale-[1.01] transition-transform flex items-center justify-center gap-2">
                <Icon name="download" /> Download {selectedOption.label}
              </button>
            </div>
          ) : (
            <button onClick={handleExport} disabled={exporting || !previewUrl}
              className="w-full bg-primary-container text-on-primary-container py-4 rounded-xl font-headline font-bold text-base hover:scale-[1.01] transition-transform disabled:opacity-50 flex items-center justify-center gap-2">
              {exporting ? 'Exporting…' : `Export as ${selectedOption.label}${selectedOption.credits > 0 ? ` (${selectedOption.creditLabel})` : ''}`}
              {!exporting && <Icon name="arrow_forward" />}
            </button>
          )}
        </div>
      </div>
    </main>
  );
}
