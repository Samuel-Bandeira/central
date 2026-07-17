import type {
  Project,
  ProjectInput,
  RunningProjects,
  Section,
  SectionInput,
  SectionStartResult,
  SectionStopResult,
  TrelloCards,
  TrelloSummary,
} from '../types';

export class ApiError extends Error {
  status: number;
  detail: unknown;

  constructor(status: number, detail: unknown, message: string) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      // corpo não era JSON, segue com body null
    }
    const detail = body && typeof body === 'object' && 'detail' in body ? (body as { detail: unknown }).detail : body;
    const message = typeof detail === 'string' ? detail : `${options?.method ?? 'GET'} ${path} falhou (${res.status})`;
    throw new ApiError(res.status, detail, message);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  listProjects: () => request<Project[]>('/projects'),
  createProject: (input: ProjectInput) =>
    request<Project>('/projects', { method: 'POST', body: JSON.stringify(input) }),
  updateProject: (id: string, input: Partial<ProjectInput>) =>
    request<Project>(`/projects/${id}`, { method: 'PUT', body: JSON.stringify(input) }),
  deleteProject: (id: string) => request<void>(`/projects/${id}`, { method: 'DELETE' }),
  getTrelloSummary: (id: string) => request<TrelloSummary>(`/projects/${id}/trello-summary`),
  getTrelloCards: (id: string) => request<TrelloCards>(`/projects/${id}/cards`),

  listSections: () => request<Section[]>('/sections'),
  createSection: (input: SectionInput) =>
    request<Section>('/sections', { method: 'POST', body: JSON.stringify(input) }),
  updateSection: (id: string, input: Partial<SectionInput>) =>
    request<Section>(`/sections/${id}`, { method: 'PUT', body: JSON.stringify(input) }),
  deleteSection: (id: string) => request<void>(`/sections/${id}`, { method: 'DELETE' }),
  startSection: (id: string) => request<SectionStartResult>(`/sections/${id}/start`, { method: 'POST' }),
  stopSection: (id: string) => request<SectionStopResult>(`/sections/${id}/stop`, { method: 'POST' }),

  pickFolder: () => request<{ path: string | null }>('/pick-folder', { method: 'POST' }),
  getRunningProjects: () => request<RunningProjects>('/running-projects'),
  openVSCode: (paths: string[]) => request<{ opened: string }>('/open-vscode', { method: 'POST', body: JSON.stringify({ paths }) }),
};
