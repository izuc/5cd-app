// Job polling for ephemeral layer AI jobs — the same 2.5s cadence as the
// studio's generation polling, but without a generation-list fallback (layer
// jobs never become generations; a lost job is simply re-submitted).

import { api } from '../../api/client';

export interface LayerJobResult {
  images: string[]; // bare base64 PNGs
  transparent?: boolean;
}

const POLL_MS = 2500;
const MAX_CONSECUTIVE_MISSES = 5;

export class JobCancelledError extends Error {
  constructor() {
    super('Cancelled.');
    this.name = 'JobCancelledError';
  }
}

export async function pollJob(
  jobId: string,
  opts: { onProgress?: (pct: number) => void; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<LayerJobResult> {
  const timeoutMs = opts.timeoutMs ?? 4 * 60_000;
  const started = Date.now();
  let misses = 0;

  while (Date.now() - started < timeoutMs) {
    if (opts.signal?.aborted) throw new JobCancelledError();
    await new Promise((r) => setTimeout(r, POLL_MS));
    if (opts.signal?.aborted) throw new JobCancelledError();

    let status: { status: string; progress: number; result?: any; error?: string };
    try {
      status = await api.getJobStatus(jobId);
    } catch {
      // 404/network: the worker may have restarted (jobs are in-memory).
      if (++misses >= MAX_CONSECUTIVE_MISSES) {
        throw new Error('Job lost — the AI service may have restarted. Please try again.');
      }
      continue;
    }
    if (status.status === 'unknown') {
      // The backend authorizes layer jobs via ai_jobs and proxies lost worker
      // jobs as HTTP 200 {status:'unknown'} — a miss, not a valid state, or a
      // restarted worker would leave this poll spinning for the full timeout.
      if (++misses >= MAX_CONSECUTIVE_MISSES) {
        throw new Error('Job lost — the AI service may have restarted. Please try again.');
      }
      continue;
    }
    misses = 0;

    if (status.status === 'completed') {
      if (status.result?.placeholder) {
        throw new Error(
          `The model is currently unavailable${status.result?.error ? ` (${status.result.error})` : ''} — please try again.`,
        );
      }
      const images = status.result?.images;
      if (Array.isArray(images) && images.length > 0) {
        return { images, transparent: !!status.result?.transparent };
      }
      throw new Error('The AI returned no image.');
    }
    if (status.status === 'failed') {
      throw new Error(status.error || 'AI job failed.');
    }
    if (typeof status.progress === 'number') opts.onProgress?.(status.progress);
  }
  throw new Error('AI job timed out — please try again.');
}
