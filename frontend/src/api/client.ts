import type {
  Activity,
  ActivityConcludeResult,
  ActivityDiffSummary,
  ActivityInput,
  ActivityProgress,
  ActivityStartResult,
  ActivityStep,
  Project,
  ProjectInput,
  RunningActivities,
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

async function handleResponse<T>(res: Response, method: string, path: string): Promise<T> {
  if (!res.ok) {
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      // corpo não era JSON, segue com body null
    }
    const detail = body && typeof body === 'object' && 'detail' in body ? (body as { detail: unknown }).detail : body;
    const message = typeof detail === 'string' ? detail : `${method} ${path} falhou (${res.status})`;
    throw new ApiError(res.status, detail, message);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  return handleResponse<T>(res, options?.method ?? 'GET', path);
}

// Sem 'Content-Type' explícito — o browser define o boundary do multipart
// sozinho a partir do FormData, e sobrescrever isso quebra o parse no
// backend.
async function requestMultipart<T>(path: string, method: string, formData: FormData): Promise<T> {
  const res = await fetch(path, { method, body: formData });
  return handleResponse<T>(res, method, path);
}

export const api = {
  listProjects: () => request<Project[]>('/projects'),
  createProject: (input: ProjectInput) =>
    request<Project>('/projects', { method: 'POST', body: JSON.stringify(input) }),
  updateProject: (id: string, input: Partial<ProjectInput>) =>
    request<Project>(`/projects/${id}`, { method: 'PUT', body: JSON.stringify(input) }),
  deleteProject: (id: string) => request<void>(`/projects/${id}`, { method: 'DELETE' }),
  getGitStatus: (id: string) =>
    request<{
      currentBranch: string | null;
      devBranch: string | null;
      upToDate: boolean | null;
      uncommittedCount: number | null;
    }>(`/projects/${id}/git-status`),
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
  getGitBranches: (path: string) => request<{ branches: string[] }>(`/git-branches?path=${encodeURIComponent(path)}`),
  getRunningProjects: () => request<RunningProjects>('/running-projects'),
  openVSCode: (paths: string[]) => request<{ opened: string }>('/open-vscode', { method: 'POST', body: JSON.stringify({ paths }) }),

  listActivities: (projectId: string) => request<Activity[]>(`/projects/${projectId}/activities`),
  createActivity: (projectId: string, input: ActivityInput) =>
    request<Activity>(`/projects/${projectId}/activities`, { method: 'POST', body: JSON.stringify(input) }),
  updateActivity: (id: string, input: Partial<ActivityInput>) =>
    request<Activity>(`/activities/${id}`, { method: 'PUT', body: JSON.stringify(input) }),
  deleteActivity: (id: string) => request<void>(`/activities/${id}`, { method: 'DELETE' }),
  startActivity: (id: string) => request<ActivityStartResult>(`/activities/${id}/start`, { method: 'POST' }),
  pauseActivity: (id: string) => request<{ sent: boolean }>(`/activities/${id}/pause`, { method: 'POST' }),
  concludeActivity: (id: string) => request<ActivityConcludeResult>(`/activities/${id}/conclude`, { method: 'POST' }),
  addActivityStep: (id: string, title: string, files: File[] = [], parentId?: string) => {
    const formData = new FormData();
    formData.set('title', title);
    if (parentId) formData.set('parentId', parentId);
    files.forEach((file) => formData.append('files', file));
    return requestMultipart<ActivityProgress>(`/activities/${id}/steps`, 'POST', formData);
  },
  deleteActivityStep: (id: string, title: string) =>
    request<ActivityProgress>(`/activities/${id}/steps`, { method: 'DELETE', body: JSON.stringify({ title }) }),
  addActivityBlock: (id: string, title: string, dependsOn: string[] = [], specFile?: File) => {
    const formData = new FormData();
    formData.set('title', title);
    dependsOn.forEach((depId) => formData.append('dependsOn', depId));
    if (specFile) formData.set('specFile', specFile);
    return requestMultipart<{ steps: ActivityStep[]; sent: boolean; needsConfirmation: boolean; blockId: string }>(
      `/activities/${id}/blocks`,
      'POST',
      formData,
    );
  },
  notifyActivityBlock: (id: string, blockId: string) =>
    request<{ sent: boolean }>(`/activities/${id}/blocks/${encodeURIComponent(blockId)}/notify`, { method: 'POST' }),
  deleteActivityBlock: (id: string, blockId: string) =>
    request<ActivityProgress>(`/activities/${id}/blocks/${encodeURIComponent(blockId)}`, { method: 'DELETE' }),
  getActivityProgress: (id: string) => request<ActivityProgress>(`/activities/${id}/progress`),
  getActivityDiffSummary: (id: string) => request<ActivityDiffSummary>(`/activities/${id}/diff-summary`),
  getRunningActivities: () => request<RunningActivities>('/running-activities'),

  uploadActivityAttachments: (id: string, files: File[]) => {
    const formData = new FormData();
    files.forEach((file) => formData.append('files', file));
    return requestMultipart<{ attachments: string[] }>(`/activities/${id}/attachments`, 'POST', formData);
  },
  deleteActivityAttachment: (id: string, path: string) =>
    request<{ attachments: string[] }>(`/activities/${id}/attachments`, { method: 'DELETE', body: JSON.stringify({ path }) }),

  uploadActivitySpec: (id: string, file: File) => {
    const formData = new FormData();
    formData.set('file', file);
    return requestMultipart<{ specFile: string }>(`/activities/${id}/spec`, 'POST', formData);
  },
  deleteActivitySpec: (id: string) => request<{ specFile: null }>(`/activities/${id}/spec`, { method: 'DELETE' }),
  validateActivityStep: (id: string, stepId: string) =>
    request<{ steps: ActivityStep[] }>(`/activities/${id}/steps/${encodeURIComponent(stepId)}/validate`, {
      method: 'POST',
    }),
  releaseActivityStep: (id: string, stepId: string, confirm = false) =>
    request<{ steps: ActivityStep[]; sent: boolean; needsConfirmation: boolean }>(
      `/activities/${id}/steps/${encodeURIComponent(stepId)}/release?confirm=${confirm}`,
      { method: 'POST' },
    ),
};
