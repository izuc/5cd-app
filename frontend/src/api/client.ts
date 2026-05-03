const API_BASE = '/api';
const TOKEN_KEY = '5cd-single-token';

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = localStorage.getItem(TOKEN_KEY);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> || {}),
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(body.message || (typeof body.error === 'string' ? body.error : null) || `Request failed: ${res.status}`);
  }
  if (res.status === 204) return {} as T;
  return res.json();
}

export interface Generation {
  id: number;
  project_id: number;
  parent_generation_id: number | null;
  prompt: string;
  model: string;
  kind: 'concept' | 'edit' | 'upload';
  output_image_url: string;
  width: number;
  height: number;
  is_chosen: boolean;
  created_at: string;
}

export interface Project {
  id: number;
  user_id: number;
  type: string;
  title: string;
  status: 'draft' | 'generating' | 'editing' | 'exported' | 'archived';
  config: Record<string, unknown>;
  ai_job_id: string | null;
  chosen_generation_id: number | null;
  created_at: string;
  updated_at: string;
  generations?: Generation[];
  chosen_generation?: Generation | null;
  thumbnail_url?: string;
}

export const api = {
  // -- Auth ----------------------------------------------------------
  register: (data: { email: string; password: string; display_name: string }) =>
    request<{ token: string; user: any }>('/auth/register', { method: 'POST', body: JSON.stringify(data) }),
  login: (data: { email: string; password: string }) =>
    request<{ token: string; user: any }>('/auth/login', { method: 'POST', body: JSON.stringify(data) }),
  me: () => request<{ user: any }>('/auth/me'),

  // -- Projects ------------------------------------------------------
  listProjects: (page = 1) => request<{ projects: Project[]; total: number; pagination: any }>(`/projects?page=${page}`),
  createProject: (data: any) => request<{ project: Project }>('/projects', { method: 'POST', body: JSON.stringify(data) }),
  getProject: (id: number) => request<{ project: Project }>(`/projects/${id}`),
  updateProject: (id: number, data: any) => request<{ project: Project }>(`/projects/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteProject: (id: number) => request<void>(`/projects/${id}`, { method: 'DELETE' }),

  // -- Generation ----------------------------------------------------
  generate: (projectId: number, opts: { prompt?: string; num_concepts?: number; width?: number; height?: number; steps?: number } = {}) =>
    request<{ job_id: string; status: string }>(`/projects/${projectId}/generate`, { method: 'POST', body: JSON.stringify(opts) }),
  edit: (projectId: number, prompt: string, imageUrl?: string, opts: { steps?: number; cfg_scale?: number } = {}) =>
    request<{ job_id: string; status: string; kind: string }>(`/projects/${projectId}/edit`, {
      method: 'POST',
      body: JSON.stringify({ prompt, image_url: imageUrl, ...opts }),
    }),
  getJobStatus: (jobId: string) =>
    request<{ status: string; progress: number; result?: any; error?: string }>(`/jobs/${jobId}/status`),
  listGenerations: (projectId: number) =>
    request<{ generations: Generation[]; project_status: string; ai_job_id: string | null }>(`/projects/${projectId}/generations`),
  chooseGeneration: (projectId: number, genId: number) =>
    request<{ message: string; generation_id: number }>(`/projects/${projectId}/generations/${genId}/choose`, { method: 'POST', body: JSON.stringify({}) }),

  // -- Exports / Credits / User --------------------------------------
  exportProject: (projectId: number, format: string) =>
    request<{ export: any }>(`/projects/${projectId}/export`, { method: 'POST', body: JSON.stringify({ format }) }),
  listExports: () => request<{ exports: any[] }>('/exports'),

  getBalance: () => request<{ balance: number }>('/credits/balance'),
  getCreditHistory: () => request<{ transactions: any[] }>('/credits/history'),
  purchaseCredits: (bundle: string) =>
    request<{ success: boolean; credits: number }>('/credits/purchase', { method: 'POST', body: JSON.stringify({ bundle }) }),

  updateTheme: (color: string) =>
    request<{ message: string }>('/user/theme', { method: 'PATCH', body: JSON.stringify({ theme_color: color }) }),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ message: string }>('/user/change-password', { method: 'POST', body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }) }),
  deleteAccount: (password: string) =>
    request<void>('/user/account', { method: 'DELETE', body: JSON.stringify({ password }) }),
};
