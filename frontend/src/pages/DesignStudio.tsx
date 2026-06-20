import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, type Generation, type Project } from '../api/client';
import { Icon } from '../components/Icon';
import { usePageTitle } from '../hooks/usePageTitle';

interface ChatMsg {
  role: 'user' | 'assistant';
  text: string;
  imageUrl?: string;
  loading?: boolean;
}

export function DesignStudio() {
  const { projectId } = useParams<{ projectId: string }>();
  usePageTitle('Studio');

  const [project, setProject] = useState<Project | null>(null);
  const [generations, setGenerations] = useState<Generation[]>([]);
  const [chosen, setChosen] = useState<Generation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [chatMessages, setChatMessages] = useState<ChatMsg[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [progress, setProgress] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [confirmRegenerate, setConfirmRegenerate] = useState(false);
  const initialKickRef = useRef(false);
  const autoChosenRef = useRef(false);
  const jobSeenRef = useRef(false);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const chatInputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [chatMessages]);

  // If there's exactly one concept and nothing is chosen, pick it automatically
  // (default num_concepts is 1, so making the user click a single thumbnail is just friction).
  const pickIfSingle = (pid: number, gens: Generation[]): Generation | null => {
    if (autoChosenRef.current) return null;
    const cgs = gens.filter((g) => g.kind === 'concept');
    if (cgs.length !== 1) return null;
    autoChosenRef.current = true;
    api.chooseGeneration(pid, cgs[0].id).catch(() => {});
    return cgs[0];
  };

  // The active version lineage: the chain's root concept + its descendant edits,
  // following parent_generation_id (handles multi-concept projects and revert
  // branches, rather than naively treating every concept as a version).
  const buildLineage = (gens: Generation[], current: Generation | null): Generation[] => {
    if (!gens.length) return [];
    const byId = new Map(gens.map((g) => [g.id, g] as const));
    let root: Generation | null =
      current ||
      gens.find((g) => g.is_chosen) ||
      gens.slice().sort((a, b) => b.id - a.id).find((g) => g.kind === 'edit') ||
      gens.filter((g) => g.kind === 'concept').sort((a, b) => a.id - b.id)[0] ||
      null;
    const guard = new Set<number>();
    while (root && root.parent_generation_id != null && byId.has(root.parent_generation_id) && !guard.has(root.id)) {
      guard.add(root.id);
      root = byId.get(root.parent_generation_id)!;
    }
    if (!root) return [];
    const inChain = new Set<number>([root.id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const g of gens) {
        if (!inChain.has(g.id) && g.parent_generation_id != null && inChain.has(g.parent_generation_id)) {
          inChain.add(g.id);
          grew = true;
        }
      }
    }
    return gens.filter((g) => inChain.has(g.id)).sort((a, b) => a.id - b.id);
  };

  // Rebuild the edit conversation from the lineage so reopening a project shows the
  // full history (the original, then each edit's instruction + its resulting image).
  const reconstructChat = (gens: Generation[], current: Generation | null): ChatMsg[] => {
    const chain = buildLineage(gens, current);
    if (!chain.some((g) => g.kind === 'edit')) return [];
    const msgs: ChatMsg[] = [];
    const root = chain[0];
    if (root && root.kind === 'concept') {
      msgs.push({ role: 'assistant', text: 'Your original design.', imageUrl: root.output_image_url + '?t=' + root.id });
    }
    for (const g of chain.filter((g) => g.kind === 'edit')) {
      msgs.push({ role: 'user', text: g.prompt || 'Edit' });
      msgs.push({ role: 'assistant', text: 'Updated design.', imageUrl: g.output_image_url + '?t=' + g.id });
    }
    return msgs;
  };

  // Load the project once
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    const pid = parseInt(projectId);

    api.getProject(pid).then((res) => {
      if (cancelled) return;
      setProject(res.project);
      const gens = res.project.generations || [];
      setGenerations(gens);
      const ch = gens.find((g) => g.is_chosen) || pickIfSingle(pid, gens) || null;
      setChosen(ch);
      // Restore the edit conversation so a returning user can browse their changes.
      setChatMessages(reconstructChat(gens, ch));

      // If draft (no generations yet, no job in flight), kick the first generation.
      if (!initialKickRef.current && res.project.status === 'draft' && gens.length === 0) {
        initialKickRef.current = true;
        const cfg = (res.project.config || {}) as any;
        api.generate(pid, {
          prompt: cfg.description,
          num_concepts: Number(cfg.numConcepts) || 1,
          width: Number(cfg.width) || 1024,
          height: Number(cfg.height) || 1024,
          steps: Number(cfg.steps) || 8,
          enhance: !!cfg.enhance,
        }).catch((err) => setError(err.message || 'Failed to start generation'));
      }
    }).catch((err) => setError(err.message));

    return () => { cancelled = true; };
  }, [projectId]);

  // Tick the elapsed-seconds counter while a generation is in flight.
  useEffect(() => {
    const generating = project?.status === 'generating' || !!project?.ai_job_id;
    if (!generating) {
      setElapsed(0);
      setProgress(0);
      return;
    }
    setElapsed(0);
    const startedAt = Date.now();
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(id);
  }, [project?.status, project?.ai_job_id]);

  // Poll for generation updates while a job is active
  useEffect(() => {
    if (!projectId) return;
    const pid = parseInt(projectId);
    let cancelled = false;

    const tick = async () => {
      try {
        const res = await api.listGenerations(pid);
        if (cancelled) return;
        const gens = res.generations || [];
        setGenerations(gens);
        const ch = gens.find((g) => g.is_chosen) || pickIfSingle(pid, gens) || null;
        if (ch) setChosen(ch);
        if (res.project_status && project) {
          setProject((p) => p ? { ...p, status: res.project_status as Project['status'], ai_job_id: res.ai_job_id } : p);
        }
        // While the job is running, also fetch its progress for the progress bar.
        if (res.ai_job_id) {
          jobSeenRef.current = true;
          try {
            const status = await api.getJobStatus(res.ai_job_id);
            if (!cancelled && typeof status.progress === 'number') setProgress(status.progress);
          } catch {}
        }
        // Stop polling once we have generations AND no active job.
        if (gens.length > 0 && !res.ai_job_id) {
          return false;
        }
        // Terminal failure: a job ran but finished with no result (e.g. the model was
        // unavailable and produced a placeholder). Stop polling and surface an error.
        if (jobSeenRef.current && !res.ai_job_id && gens.length === 0) {
          setError('Generation failed — the model was unavailable. Please try again.');
          return false;
        }
      } catch {}
      return true;
    };

    let stopped = false;
    (async () => {
      while (!cancelled && !stopped) {
        const keepGoing = await tick();
        if (keepGoing === false) stopped = true;
        await new Promise((r) => setTimeout(r, 2500));
      }
    })();

    return () => { cancelled = true; };
  }, [projectId, project?.ai_job_id]);

  const handleChoose = async (gen: Generation) => {
    if (!projectId || busy) return;
    setChosen(gen);
    setGenerations((prev) => prev.map((g) => ({ ...g, is_chosen: g.id === gen.id })));
    try {
      await api.chooseGeneration(parseInt(projectId), gen.id);
    } catch (err: any) {
      setError(err.message || 'Failed to set chosen design');
    }
  };

  const handleSendChat = async () => {
    if (!projectId || !chosen || !chatInput.trim() || busy) return;
    const msg = chatInput.trim();
    setChatInput('');
    setBusy(true);
    setChatMessages((prev) => [...prev, { role: 'user', text: msg }, { role: 'assistant', text: '', loading: true }]);

    try {
      const res = await api.edit(parseInt(projectId), msg, chosen.output_image_url);
      const jobId = res.job_id;
      // Edits already present before this run — lets us detect the new one if the
      // background poll claims + saves the job before this loop sees it complete.
      const priorEditIds = new Set((generations || []).filter((g) => g.kind === 'edit').map((g) => g.id));
      let done = false;
      for (let i = 0; i < 240; i++) {
        await new Promise((r) => setTimeout(r, 2500));
        let status;
        try {
          status = await api.getJobStatus(jobId);
        } catch {
          // getJobStatus 404s once the background poll clears ai_job_id — check whether
          // a new edit generation has landed and treat that as success.
          try {
            const list = await api.listGenerations(parseInt(projectId));
            const fresh = (list.generations || []).filter((g) => g.kind === 'edit' && !priorEditIds.has(g.id));
            if (fresh.length) {
              const ng = fresh[fresh.length - 1];
              setGenerations(list.generations);
              setChosen(ng);
              setChatMessages((prev) => [...prev.slice(0, -1), { role: 'assistant', text: 'Done — here is the updated design.', imageUrl: ng.output_image_url + '?t=' + Date.now() }]);
              done = true;
              break;
            }
          } catch {}
          continue; // otherwise keep waiting — the job is still running
        }
        if (status.status === 'completed' && status.result?.placeholder) {
          setChatMessages((prev) => [...prev.slice(0, -1), { role: 'assistant', text: `The model is currently unavailable${status.result?.error ? ` (${status.result.error})` : ''} — please try again.` }]);
          done = true;
          break;
        }
        if (status.status === 'completed' && status.result?.images?.[0]) {
          // Refresh generations from backend so we get the saved image URL.
          const list = await api.listGenerations(parseInt(projectId));
          const newest = (list.generations || []).slice().reverse().find((g) => g.kind === 'edit') || null;
          if (newest) {
            setGenerations(list.generations);
            setChosen(newest);
            setChatMessages((prev) => [
              ...prev.slice(0, -1),
              { role: 'assistant', text: 'Done — here is the updated design.', imageUrl: newest.output_image_url + '?t=' + Date.now() },
            ]);
          } else {
            setChatMessages((prev) => [...prev.slice(0, -1), { role: 'assistant', text: 'Edit completed but no image was returned.' }]);
          }
          done = true;
          break;
        }
        if (status.status === 'failed') {
          setChatMessages((prev) => [...prev.slice(0, -1), { role: 'assistant', text: `Edit failed: ${status.error || 'unknown error'}.` }]);
          done = true;
          break;
        }
      }
      if (!done) {
        setChatMessages((prev) => [...prev.slice(0, -1), { role: 'assistant', text: 'Edit timed out — try again.' }]);
      }
    } catch (err: any) {
      setChatMessages((prev) => [...prev.slice(0, -1), { role: 'assistant', text: err.message || 'Edit failed.' }]);
    } finally {
      setBusy(false);
    }
  };

  const handleRegenerate = async () => {
    if (!projectId || !project) return;
    setConfirmRegenerate(false);
    setError('');
    setChatMessages([]);
    // Clear the old concepts/chosen immediately so the studio shows progress (not the
    // stale design) — the backend also deletes them when the new job is accepted.
    setGenerations([]);
    setChosen(null);
    initialKickRef.current = true;
    autoChosenRef.current = false;
    const cfg = (project.config || {}) as any;
    try {
      await api.generate(parseInt(projectId), {
        prompt: cfg.description,
        num_concepts: Number(cfg.numConcepts) || 1,
        width: Number(cfg.width) || 1024,
        height: Number(cfg.height) || 1024,
        steps: Number(cfg.steps) || 8,
        enhance: !!cfg.enhance,
      });
      setProject((p) => p ? { ...p, status: 'generating', ai_job_id: 'pending' } : p);
    } catch (err: any) {
      setError(err.message || 'Failed to regenerate');
    }
  };

  if (!project) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        {error
          ? <div className="text-center"><Icon name="error" className="text-5xl text-error mb-3" /><p className="text-on-surface-variant">{error}</p></div>
          : <div className="text-center text-on-surface-variant">Loading…</div>}
      </div>
    );
  }

  const cfg = (project.config || {}) as any;
  const generating = project.status === 'generating' || (!!project.ai_job_id);
  const concepts = generations.filter((g) => g.kind === 'concept');
  const editHistory = generations.filter((g) => g.kind === 'edit');
  const lineage = buildLineage(generations, chosen);

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Top bar */}
      <div className="flex items-center justify-between px-4 sm:px-8 py-4 border-b border-outline-variant/10 bg-surface">
        <div className="flex items-center gap-3 min-w-0">
          <Link to="/dashboard" className="text-on-surface-variant hover:text-on-surface" aria-label="Back to dashboard">
            <Icon name="arrow_back" />
          </Link>
          <div className="min-w-0">
            <h1 className="font-headline font-bold text-base sm:text-lg truncate">{project.title}</h1>
            <p className="text-xs text-on-surface-variant truncate">{cfg.description || `${project.type} project`}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setConfirmRegenerate(true)} disabled={generating}
            className="flex items-center gap-1.5 bg-surface-container-high px-3 py-2 rounded-xl text-xs font-bold disabled:opacity-50 hover:bg-surface-container-highest"
            title="Regenerate (replaces current concepts)">
            <Icon name="autorenew" className="text-base" /> Regenerate
          </button>
          <Link to={`/export/${project.id}`}
            className={`flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-bold transition-all ${
              chosen ? 'bg-primary-container text-on-primary-container hover:scale-105' : 'bg-surface-container-high text-on-surface-variant pointer-events-none opacity-50'
            }`}>
            <Icon name="download" className="text-base" /> Export
          </Link>
        </div>
      </div>

      <div className="flex-1 flex flex-col lg:flex-row overflow-hidden">
        {/* Left: image / concept picker */}
        <div className="lg:w-3/5 flex flex-col bg-surface-container-low overflow-hidden">
          {error && (
            <div className="m-4 px-4 py-3 rounded-xl bg-error-container/10 text-error text-sm flex items-center gap-2">
              <Icon name="error" className="text-base" /> {error}
            </div>
          )}

          <div className="flex-1 flex items-center justify-center p-6 min-h-[300px]">
            {chosen ? (
              <img src={chosen.output_image_url + '?t=' + chosen.id}
                alt="Selected design" className="max-w-full max-h-full object-contain rounded-2xl shadow-xl bg-white" />
            ) : generating ? (
              <div className="w-full max-w-sm space-y-5">
                <div className="text-center space-y-1">
                  <h2 className="font-headline font-black text-xl">Generating…</h2>
                  <p className="text-on-surface-variant text-sm">First generation can take a couple of minutes.</p>
                </div>
                <div className="space-y-2">
                  <div className="h-2 bg-surface-container-high rounded-full overflow-hidden">
                    <div
                      className="h-full bg-primary rounded-full transition-[width] duration-500"
                      style={{ width: `${Math.max(progress, Math.min(95, elapsed * 1.2))}%` }} />
                  </div>
                  <div className="flex justify-between font-label text-[10px] uppercase tracking-widest text-on-surface-variant">
                    <span>{progress > 0 ? `${progress}%` : 'Warming up'}</span>
                    <span>{Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')}</span>
                  </div>
                </div>
              </div>
            ) : concepts.length > 0 ? (
              <div className="text-center text-on-surface-variant">
                <Icon name="touch_app" className="text-4xl mb-3" />
                <p>Pick a concept below to start editing.</p>
              </div>
            ) : (
              <div className="text-center text-on-surface-variant">
                <Icon name="hourglass_empty" className="text-4xl mb-3" />
                <p>Waiting for generations…</p>
              </div>
            )}
          </div>

          {concepts.length > 1 && (
            <div className="border-t border-outline-variant/10 p-4 bg-surface-container-lowest">
              <p className="font-label text-[10px] uppercase tracking-widest text-on-surface-variant mb-3">Concepts</p>
              <div className="flex gap-3 overflow-x-auto">
                {concepts.map((g, i) => (
                  <button key={g.id} onClick={() => handleChoose(g)} disabled={busy}
                    className={`flex-shrink-0 w-24 h-24 rounded-xl overflow-hidden ring-2 transition-all disabled:opacity-60 ${
                      chosen?.id === g.id ? 'ring-primary scale-105' : 'ring-transparent hover:ring-primary/40'
                    }`}>
                    <img src={g.output_image_url} alt={`Concept ${i + 1}`} className="w-full h-full object-cover" />
                  </button>
                ))}
              </div>
            </div>
          )}

          {editHistory.length > 0 && (
            <div className="border-t border-outline-variant/10 p-4 bg-surface-container-lowest">
              <p className="font-label text-[10px] uppercase tracking-widest text-on-surface-variant mb-3">Versions · click to revert</p>
              <div className="flex gap-3 overflow-x-auto">
                {lineage.map((g, i) => (
                  <button key={g.id} onClick={() => handleChoose(g)} disabled={busy}
                    title={g.kind === 'edit' ? (g.prompt ? 'Edit: ' + g.prompt : 'Edit') : 'Original concept'}
                    className={`relative flex-shrink-0 w-20 h-20 rounded-lg overflow-hidden ring-2 transition-all disabled:opacity-60 ${
                      chosen?.id === g.id ? 'ring-primary' : 'ring-transparent hover:ring-primary/40'
                    }`}>
                    <img src={g.output_image_url} alt={g.kind === 'edit' ? 'Edit version' : 'Original'} className="w-full h-full object-cover" />
                    <span className="absolute bottom-0 inset-x-0 bg-black/55 text-white text-[9px] font-label text-center py-0.5 leading-tight">v{i + 1}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Right: chat */}
        <div className="lg:w-2/5 flex flex-col bg-surface border-l border-outline-variant/10">
          <div className="p-4 border-b border-outline-variant/10 flex items-center gap-3">
            <div className="w-8 h-8 rounded-full bg-primary-container flex items-center justify-center">
              <Icon name="chat" className="text-sm text-on-primary-container" />
            </div>
            <div>
              <h3 className="font-headline font-bold text-sm">Edit chat</h3>
              <p className="text-xs text-on-surface-variant">Describe what to change.</p>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {chatMessages.length === 0 ? (
              <div className="text-on-surface-variant text-sm text-center mt-12 px-6">
                {chosen
                  ? 'Try things like “make the background a deep navy”, “change the typography to serif”, or “add a small subtitle that says SINCE 2026”.'
                  : 'Pick a concept on the left first, then edit it via chat.'}
              </div>
            ) : (
              chatMessages.map((msg, i) => (
                <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'} gap-2`}>
                  <div className={`max-w-[85%] rounded-2xl px-4 py-3 ${
                    msg.role === 'user'
                      ? 'bg-primary-container text-on-primary-container rounded-br-md'
                      : 'bg-surface-container-high text-on-surface rounded-bl-md'
                  }`}>
                    {msg.loading ? (
                      <div className="flex items-center gap-2 py-1">
                        <div className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                        <span className="text-sm text-on-surface-variant">Editing image…</span>
                      </div>
                    ) : (
                      <>
                        <p className="text-sm leading-relaxed whitespace-pre-wrap">{msg.text}</p>
                        {msg.imageUrl && <img src={msg.imageUrl} alt="Edit result" className="mt-3 rounded-xl max-w-full border border-outline-variant/10" />}
                      </>
                    )}
                  </div>
                </div>
              ))
            )}
            <div ref={chatEndRef} />
          </div>

          <div className="p-4 border-t border-outline-variant/10">
            <form onSubmit={(e) => { e.preventDefault(); handleSendChat(); }} className="flex gap-2 items-end">
              <textarea ref={chatInputRef} value={chatInput} rows={1}
                onChange={(e) => {
                  setChatInput(e.target.value);
                  // Auto-grow up to ~3 lines.
                  const el = e.target as HTMLTextAreaElement;
                  el.style.height = 'auto';
                  el.style.height = Math.min(el.scrollHeight, 96) + 'px';
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleSendChat();
                  }
                }}
                disabled={busy || !chosen}
                placeholder={chosen ? 'Describe your edit (Shift+Enter for newline)' : 'Pick a concept first'}
                className="flex-1 bg-surface-container-lowest border border-outline-variant/20 rounded-2xl px-5 py-3 text-sm focus:ring-2 focus:ring-primary/40 focus:border-primary disabled:opacity-50 placeholder:text-outline-variant resize-none leading-relaxed" />
              <button type="submit" disabled={busy || !chatInput.trim() || !chosen}
                className="bg-primary text-on-primary w-11 h-11 rounded-2xl flex items-center justify-center disabled:opacity-50 active:scale-90 transition-all shadow-lg shadow-primary/20 flex-shrink-0"
                aria-label="Send edit">
                <Icon name="send" className="text-lg" />
              </button>
            </form>
          </div>
        </div>
      </div>

      {confirmRegenerate && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/30 backdrop-blur-sm" onClick={() => setConfirmRegenerate(false)}>
          <div className="bg-surface-container-lowest rounded-2xl shadow-2xl w-full max-w-sm mx-4 p-6 space-y-4" onClick={(e) => e.stopPropagation()}>
            <h3 className="font-headline font-bold text-lg">Regenerate concepts?</h3>
            <p className="text-on-surface-variant text-sm">
              The current concepts and edit history will be replaced. This can&apos;t be undone.
            </p>
            <div className="flex gap-3 justify-end">
              <button onClick={() => setConfirmRegenerate(false)}
                className="px-5 py-2.5 rounded-xl font-headline font-bold text-sm bg-surface-container-high">
                Cancel
              </button>
              <button onClick={handleRegenerate}
                className="px-5 py-2.5 rounded-xl font-headline font-bold text-sm bg-primary-container text-on-primary-container">
                Regenerate
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
