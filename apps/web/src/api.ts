import { getLang } from './i18n';
// Client HTTP del server AgiCloud: REST per i comandi, SSE (via fetch) per gli eventi AG-UI.

import type { BaseEvent } from '@ag-ui/core';

export interface AgentInfo {
  id: string;
  label: string;
  native: boolean;
  note?: string;
}

export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  /** ui/icon solo per i plugin esterni: la loro schermata (stessa origine) e l'icona del menu */
  section: { id: string; label: string; icon?: string | null; ui?: string } | null;
  credits: { text: string; url: string } | null;
  requires: string | null;
  source: string;
  /** Plugin esterni: dal catalogo della macchina o installato da link */
  origin?: 'catalog' | 'link' | null;
  installed: boolean;
  enabled: boolean;
  health: { ok: boolean; detail: string } | null;
}

export type ThreadStatus = 'idle' | 'starting' | 'ready' | 'running' | 'auth_required' | 'error';

export interface ThreadSummary {
  id: string;
  agentId: string;
  cwd: string;
  project: string;
  title: string;
  status: ThreadStatus;
  createdAt: number;
  updatedAt: number;
  pinned: boolean;
  archived: boolean;
  /** Conversazione capo: puo' affidare compiti ad altri agenti */
  lead: boolean;
  /** Thread affidato da un capo */
  parentId: string | null;
  childState: 'running' | 'waiting' | 'done' | 'error' | 'idle' | null;
  /** Thread affidato in attesa di un tuo permesso */
  pendingPermission: { requestId: string; title: string; options: { optionId: string; name: string; kind: string }[] } | null;
  worktree: { branch: string; state: 'open' | 'merged' | 'discarded' } | null;
  /** Plugin Design: skill e design system scelti alla creazione */
  design: DesignChoice | null;
  /** Chat del Browser condiviso */
  browser: boolean;
  /** Passaggio di consegne: da quale conversazione arriva il lavoro / a quale e' passato */
  handoverFrom: string | null;
  handedOverTo: string | null;
}

export interface DesignChoice {
  skill?: string;
  system?: string;
}

/** Catalogo del plugin Design (packages/design, contenuti da Open Design) */
export interface DesignCatalog {
  source: { repo: string; commit: string };
  systems: { id: string; name: string; category: string; description: string; craft: string[]; previews: string[]; kit: boolean }[];
  skills: {
    id: string;
    name: string;
    emoji?: string;
    description: string;
    mode: string;
    category: string;
    craft: string[];
    needsSystem: boolean;
    examplePrompt?: string;
    example: boolean;
  }[];
  craft: string[];
}

export interface WorktreeChanges {
  files: { path: string; added: number; removed: number }[];
  patch: string;
  truncated: boolean;
  worktree: { branch: string; state: 'open' | 'merged' | 'discarded' } | null;
}

export interface SearchHit {
  id: string;
  snippet: string;
  inTitle: boolean;
}

export interface UploadedFile {
  name: string;
  /** Relativo alla cartella del progetto */
  path: string;
  size: number;
  mime: string;
}

export interface TerminalSummary {
  id: string;
  cwd: string;
  project: string;
  title: string;
  createdAt: number;
  exited: boolean;
  threadId?: string | null;
}

export interface SessionInfo {
  ok: boolean;
  authRequired?: boolean;
  setupPending?: boolean;
  /** Sezioni consentite dal piano: null = tutto */
  features?: string[] | null;
}

export interface VaultKey {
  name: string;
  note: string;
  agents: boolean;
  terminals: boolean;
  updatedAt: number;
  last4: string;
  blockedFor: string[];
}

export interface GuidedLogin {
  agentId: string;
  state: 'waiting' | 'checking' | 'done' | 'failed';
  url: string | null;
  needsCode: boolean;
  askingCode: boolean;
  output: string;
  error: string | null;
}

export interface AgentStatus {
  id: string;
  label: string;
  /** false = per ora solo login (es. agy) */
  chat: boolean;
  note?: string;
  installed: boolean;
  version: string | null;
  login: { state: 'ok' | 'missing' | 'unknown'; detail: string };
  loginCommand: string | null;
  /** Installer ufficiale (agenti non presenti nell'immagine) */
  installCommand: string | null;
  /** Login dal browser (link + codice), senza terminale */
  guidedLogin: boolean;
  env: { name: string; label: string; set: boolean }[];
  defaults: Record<string, string | boolean>;
  options: import('./transcript').ConfigOption[];
}

export interface GeneralSettings {
  projectRoots: string[];
  idleMinutes: number;
}

export interface FileEntry {
  name: string;
  path: string;
  type: 'dir' | 'file' | 'link';
  size: number;
  mtime: number;
}

export interface FileContent {
  path: string;
  content: string | null;
  binary: boolean;
  tooLarge: boolean;
  size: number;
  mtime: number;
  mime: string;
}

export interface DirListing {
  path: string | null;
  parent: string | null;
  dirs: { name: string; path: string; git: boolean }[];
}

const TOKEN_KEY = 'agicloud_token';

export function getToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

export function setToken(token: string): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage non disponibile: il token vale solo per questa pagina */
  }
  memoryToken = token;
}

let memoryToken = getToken();

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      ...(memoryToken ? { authorization: `Bearer ${memoryToken}` } : {}),
      'accept-language': getLang(),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(res.status, data.error ?? `Errore ${res.status}`);
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

/** Come request(), ma con corpo e risposta liberi (multipart, file binari) */
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { ...(memoryToken ? { authorization: `Bearer ${memoryToken}` } : {}), 'accept-language': getLang(), ...(init.headers as Record<string, string> | undefined) },
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(res.status, data.error ?? data.detail ?? `Errore ${res.status}`);
  }
  return res;
}

export interface PiiTag {
  tag: string;
  it: string;
  example: string;
}

export interface PiiSegment {
  t: string;
  label?: string;
  ph?: string;
}

export interface PiiResult {
  anonymized_text: string;
  n_entities: number;
  n_unique: number;
  by_label: Record<string, number>;
  mapping?: Record<string, string>;
  segments: PiiSegment[];
}

export interface PiiPdf {
  doc_id: string;
  n_pages: number;
  redactions: number;
  residual?: number;
  filename?: string;
}

export type VerdictType = 'yesno' | 'choice' | 'score';

export interface VerdictResult {
  answer: string;
  confidence: number;
  probabilities: { option: string; p: number }[];
  uncertain: boolean;
  note: string | null;
  method: 'logprobs' | 'campioni';
  models: string[];
  expected?: number;
  explanation?: string;
  ms: number;
  cost: number;
}

export interface VideoClip {
  id: string;
  type: 'image' | 'video' | 'title' | 'audio';
  path?: string;
  text?: string;
  color?: string;
  start: number;
  duration: number;
  fadeIn?: number;
  fadeOut?: number;
}

export interface VideoTrack {
  id: string;
  type: 'video' | 'audio';
  name: string;
  clips: VideoClip[];
}

export interface VideoProject {
  version: string;
  title: string;
  width: number;
  height: number;
  fps: number;
  duration: number;
  tracks: VideoTrack[];
}

export interface VideoRenderResult {
  file: string;
  name: string;
  path?: string;
}

export interface VideoMediaFile {
  path: string;
  name: string;
  type: 'video' | 'image' | 'audio';
  size: number;
  duration?: number;
  width?: number;
  height?: number;
  mtime?: number;
}

export interface NotebookMeta {
  id: string;
  title: string;
  createdAt: string;
  conversationId: string | null;
}

export interface NotebookSource {
  name: string;
  size: number;
  mtime: number;
}

export interface NotebookStudioItem {
  name: string;
  kind: string;
  size: number;
  mtime: number;
}

export interface NotebookChatMessage {
  role: 'q' | 'a';
  text: string;
  ts: number;
}

export interface NotebookSettings {
  provider: 'edge' | 'elevenlabs';
  providerChosen: boolean;
  elevenlabs: {
    hasKey: boolean;
    keySource: 'settings' | 'vault' | 'env' | null;
    keyHint: string;
    model: string;
    models: string[];
    voiceA: string;
    voiceB: string;
    voiceAName: string;
    voiceBName: string;
  };
}

export interface NotebookVoice {
  id: string;
  name: string;
  category: string;
  labels: Record<string, string>;
  preview: string;
}

export interface NotebookQuota {
  used: number;
  limit: number;
  tier: string;
  resetAt: number;
}

export interface ClaudeLimit {  status: 'allowed' | 'allowed_warning' | 'rejected';
  type: string | null;
  utilization: number | null;
  resetsAt: number | null;
  warning: boolean;
  blocked: boolean;
  message?: string;
}

export const api = {
  session: () => request<SessionInfo>('GET', '/session'),
  agents: () => request<AgentInfo[]>('GET', '/agents'),
  projects: () => request<{ roots: string[]; recent: string[] }>('GET', '/projects'),
  dirs: (path?: string) => request<DirListing>('GET', `/dirs${path ? `?path=${encodeURIComponent(path)}` : ''}`),
  threads: () => request<ThreadSummary[]>('GET', '/threads'),
  updateThread: (id: string, patch: { title?: string; pinned?: boolean; archived?: boolean }) =>
    request<ThreadSummary>('PATCH', `/threads/${id}`, patch),
  searchThreads: (q: string) => request<SearchHit[]>('GET', `/threads/search?q=${encodeURIComponent(q)}`),
  createThread: (agentId: string, cwd: string, lead = false, design: DesignChoice | null = null, browser = false) =>
    request<ThreadSummary>('POST', '/threads', { agentId, cwd, lead, design, browser }),
  piiTags: async () => ((await (await apiFetch('/pii/engine/settings')).json()) as { tags: PiiTag[] }).tags,
  piiAnalyze: async (input: { text: string } | { file: File }, exclude: string[], mapping: boolean): Promise<PiiResult> => {
    if ('text' in input) {
      const res = await apiFetch('/pii/engine/analyze', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: input.text, exclude_tags: exclude, include_mapping: mapping }),
      });
      return res.json();
    }
    const fd = new FormData();
    fd.append('file', input.file, input.file.name);
    if (exclude.length) fd.append('exclude_tags', exclude.join(','));
    fd.append('include_mapping', mapping ? '1' : '0');
    return (await apiFetch('/pii/engine/analyze', { method: 'POST', body: fd })).json();
  },
  piiPdfPreview: async (file: File, exclude: string[]): Promise<PiiPdf> => {
    const fd = new FormData();
    fd.append('pdf', file, file.name);
    if (exclude.length) fd.append('exclude_tags', exclude.join(','));
    fd.append('include_mapping', '0');
    return (await apiFetch('/pii/engine/pdf/preview', { method: 'POST', body: fd })).json();
  },
  piiPage: async (docId: string, page: number) => (await apiFetch(`/pii/engine/doc/${docId}/page/${page}.png`)).blob(),
  piiDocFile: async (docId: string) => (await apiFetch(`/pii/engine/doc/${docId}/file.pdf`)).blob(),
  piiSave: (body: { project: string; name: string; exclude_tags: string[]; text?: string; doc_id?: string }) =>
    request<{ path: string; abs: string; size: number }>('POST', '/pii/save', body),
  verdict: (body: { text: string; question: string; type: VerdictType; options?: string[]; mode: 'fast' | 'double'; explain: boolean }) =>
    request<VerdictResult>('POST', '/verdict/decide', body),
  notebook: {
    health: () => request<{ available: boolean; detail: string; version: string | null }>('GET', '/notebook/health'),
    settings: () => request<NotebookSettings>('GET', '/notebook/settings'),
    saveSettings: (body: {
      provider?: 'edge' | 'elevenlabs';
      elevenlabsKey?: string;
      model?: string;
      voiceA?: string;
      voiceB?: string;
      voiceAName?: string;
      voiceBName?: string;
    }) => request<NotebookSettings>('POST', '/notebook/settings', body),
    voices: () => request<{ voices: NotebookVoice[]; quota: NotebookQuota | null }>('GET', '/notebook/elevenlabs/voices'),
    list: (wspath: string) => request<NotebookMeta[]>('GET', `/notebook/notebooks?wspath=${encodeURIComponent(wspath)}`),
    create: (wspath: string, title: string) => request<NotebookMeta>('POST', '/notebook/notebooks', { wspath, title }),
    remove: (id: string, wspath: string) =>
      request<{ success: boolean }>('DELETE', `/notebook/notebooks/${encodeURIComponent(id)}?wspath=${encodeURIComponent(wspath)}`),
    sources: (id: string, wspath: string) =>
      request<NotebookSource[]>('GET', `/notebook/notebooks/${encodeURIComponent(id)}/sources?wspath=${encodeURIComponent(wspath)}`),
    addSource: (id: string, body: { wspath: string; url?: string; text?: string; title?: string; fileName?: string; fileData?: string; piiFile?: string }) =>
      request<{ name: string }>('POST', `/notebook/notebooks/${encodeURIComponent(id)}/sources`, body),
    sourceContent: (id: string, name: string, wspath: string) =>
      request<{ name: string; content: string }>(
        'GET',
        `/notebook/notebooks/${encodeURIComponent(id)}/sources/${encodeURIComponent(name)}/content?wspath=${encodeURIComponent(wspath)}`,
      ),
    deleteSource: (id: string, name: string, wspath: string) =>
      request<{ success: boolean }>(
        'DELETE',
        `/notebook/notebooks/${encodeURIComponent(id)}/sources/${encodeURIComponent(name)}?wspath=${encodeURIComponent(wspath)}`,
      ),
    chat: (id: string, wspath: string) =>
      request<NotebookChatMessage[]>('GET', `/notebook/notebooks/${encodeURIComponent(id)}/chat?wspath=${encodeURIComponent(wspath)}`),
    query: (id: string, wspath: string, question: string) =>
      request<{ answer: string }>('POST', `/notebook/notebooks/${encodeURIComponent(id)}/query`, { wspath, question }),
    studio: (id: string, wspath: string) =>
      request<NotebookStudioItem[]>('GET', `/notebook/notebooks/${encodeURIComponent(id)}/studio?wspath=${encodeURIComponent(wspath)}`),
    createStudio: (id: string, wspath: string, kind: string, provider?: string) =>
      request<{ name: string; provider?: string }>('POST', `/notebook/notebooks/${encodeURIComponent(id)}/studio`, { wspath, kind, provider }),
    artifactContent: (id: string, name: string, wspath: string) =>
      request<{ name: string; content: string }>(
        'GET',
        `/notebook/notebooks/${encodeURIComponent(id)}/studio/${encodeURIComponent(name)}/content?wspath=${encodeURIComponent(wspath)}`,
      ),
    deleteArtifact: (id: string, name: string, wspath: string) =>
      request<{ success: boolean }>(
        'DELETE',
        `/notebook/notebooks/${encodeURIComponent(id)}/studio/${encodeURIComponent(name)}?wspath=${encodeURIComponent(wspath)}`,
      ),
  },
  video: {
    list: () => request<{ name: string; title: string }[]>('GET', '/video/projects'),
    get: (name: string) => request<VideoProject>('GET', `/video/projects/${encodeURIComponent(name)}`),
    save: (name: string, project: VideoProject) => request<{ ok: boolean }>('PUT', `/video/projects/${encodeURIComponent(name)}`, project),
    render: (body: { project?: VideoProject; name?: string; out?: string }) =>
      request<VideoRenderResult>('POST', '/video/render', body),
    media: () => request<VideoMediaFile[]>('GET', '/video/media'),
    upload: async (files: File[]): Promise<VideoMediaFile[]> => {
      const form = new FormData();
      for (const f of files) form.append('files', f, f.name);
      const res = await fetch('/api/video/upload', {
        method: 'POST',
        headers: memoryToken ? { authorization: `Bearer ${memoryToken}` } : {},
        body: form,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new ApiError(res.status, data.error ?? `Errore ${res.status}`);
      }
      const data = await res.json();
      return data.files;
    },
    mediaUrl: (path: string): string =>
      `/api/files/raw?path=${encodeURIComponent(path)}${memoryToken ? `&token=${encodeURIComponent(memoryToken)}` : ''}`,
  },
  limits: () => request<{ claude: ClaudeLimit | null }>('GET', '/limits'),
  handover: (threadId: string, agentId: string) => request<ThreadSummary>('POST', `/threads/${threadId}/handover`, { agentId }),
  setup: (setup: string) => request<{ token: string }>('POST', '/setup', { setup }),
  plugins: () => request<PluginInfo[]>('GET', '/plugins'),
  installPlugin: (id: string) => request<PluginInfo[]>('POST', `/plugins/${id}/install`),
  installPluginLink: (url: string) => request<PluginInfo[]>('POST', '/plugins/install-link', { url }),
  uninstallPlugin: (id: string) => request<PluginInfo[]>('POST', `/plugins/${id}/uninstall`),
  setPluginEnabled: (id: string, enabled: boolean) => request<PluginInfo[]>('POST', `/plugins/${id}/enabled`, { enabled }),
  mcp: {
    list: () =>
      request<{
        builtin: { name: string; label: string; enabled: boolean }[];
        custom: {
          name: string;
          type: 'stdio' | 'http' | 'sse';
          command?: string;
          args?: string[];
          env?: Record<string, string>;
          url?: string;
          headers?: Record<string, string>;
          enabled: boolean;
        }[];
      }>('GET', '/mcp'),
    save: (body: {
      name: string;
      type: 'stdio' | 'http' | 'sse';
      command?: string;
      args?: string[] | string;
      env?: Record<string, string>;
      url?: string;
      headers?: Record<string, string>;
      enabled?: boolean;
    }) => request<any>('POST', '/mcp', body),
    setEnabled: (name: string, enabled: boolean) => request<any>('POST', `/mcp/${encodeURIComponent(name)}/enabled`, { enabled }),
    remove: (name: string) => request<any>('DELETE', `/mcp/${encodeURIComponent(name)}`),
  },
  browserScreenshot: async (): Promise<Blob> => (await apiFetch('/browser/screenshot')).blob(),
  designCatalog: () => request<DesignCatalog>('GET', '/design/catalog'),
  /** URL di anteprima (sandbox, scade dopo qualche ora) per una cartella di progetto o un elemento del catalogo */
  designPreview: (target: { dir: string } | { system: string } | { skill: string }) =>
    request<{ url: string; expires: number }>('POST', '/design/previews', target),
  decideDelegation: (threadId: string, delegationId: string, approve: boolean, note: string) =>
    request<{ childId?: string }>('POST', `/threads/${threadId}/delegations/${delegationId}`, { approve, note }),
  threadChanges: (id: string) => request<WorktreeChanges>('GET', `/threads/${id}/changes`),
  mergeThread: (id: string) => request<{ commit: string }>('POST', `/threads/${id}/merge`),
  discardThread: (id: string) => request<void>('POST', `/threads/${id}/discard`),
  settings: (refresh = false) =>
    request<{ general: GeneralSettings; agents: AgentStatus[] }>('GET', `/settings${refresh ? '?refresh=1' : ''}`),
  saveGeneral: (g: Partial<GeneralSettings>) => request<GeneralSettings>('POST', '/settings/general', g),
  setAgentEnv: (agentId: string, name: string, value: string | null) =>
    request<void>('POST', `/settings/agents/${agentId}/env`, { name, value }),
  setAgentDefault: (agentId: string, configId: string, value: string | boolean | null) =>
    request<void>('POST', `/settings/agents/${agentId}/defaults`, { configId, value }),
  vault: () => request<VaultKey[]>('GET', '/settings/vault'),
  saveVaultKey: (k: { name: string; value?: string; note?: string; agents?: boolean; terminals?: boolean }) =>
    request<VaultKey[]>('POST', '/settings/vault', k),
  deleteVaultKey: (name: string) => request<VaultKey[]>('DELETE', `/settings/vault/${encodeURIComponent(name)}`),
  agentLogin: (agentId: string) => request<TerminalSummary>('POST', `/settings/agents/${agentId}/login`),
  agentInstall: (id: string) => request<TerminalSummary>('POST', `/settings/agents/${id}/install`),
  startGuidedLogin: (agentId: string) => request<GuidedLogin>('POST', `/settings/agents/${agentId}/login/guided`),
  guidedLoginStatus: (agentId: string) => request<GuidedLogin | null>('GET', `/settings/agents/${agentId}/login/guided`),
  sendGuidedLoginCode: (agentId: string, code: string) =>
    request<GuidedLogin>('POST', `/settings/agents/${agentId}/login/guided/code`, { code }),
  cancelGuidedLogin: (agentId: string) => request<void>('DELETE', `/settings/agents/${agentId}/login/guided`),
  listFiles: (path: string) =>
    request<{ path: string; parent: string | null; entries: FileEntry[]; truncated: boolean }>('GET', `/files/list?path=${encodeURIComponent(path)}`),
  readFile: (path: string) => request<FileContent>('GET', `/files/read?path=${encodeURIComponent(path)}`),
  writeFile: (path: string, content: string, mtime?: number) => request<{ mtime: number }>('PUT', '/files/write', { path, content, mtime }),
  createFile: (path: string, type: 'file' | 'dir') => request<FileEntry>('POST', '/files/create', { path, type }),
  renameFile: (path: string, name: string) => request<{ path: string }>('POST', '/files/rename', { path, name }),
  deleteFile: (path: string) => request<void>('DELETE', `/files?path=${encodeURIComponent(path)}`),
  /** Contenuto grezzo come Blob (anteprime e download): serve il token, quindi niente <img src> diretto */
  fileBlob: async (path: string): Promise<Blob> => {
    const res = await fetch(`/api/files/raw?path=${encodeURIComponent(path)}`, {
      headers: memoryToken ? { authorization: `Bearer ${memoryToken}` } : {},
    });
    if (!res.ok) throw new ApiError(res.status, `Errore ${res.status}`);
    return res.blob();
  },
  uploadFiles: async (dir: string, files: File[]): Promise<FileEntry[]> => {
    const form = new FormData();
    for (const f of files) form.append('files', f, f.name);
    const res = await fetch(`/api/files/upload?dir=${encodeURIComponent(dir)}`, {
      method: 'POST',
      headers: memoryToken ? { authorization: `Bearer ${memoryToken}` } : {},
      body: form,
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new ApiError(res.status, data.error ?? `Errore ${res.status}`);
    }
    return res.json();
  },
  push: () => request<{ publicKey: string; devices: { endpoint: string; device: string }[] }>('GET', '/push'),
  pushSubscribe: (subscription: unknown, device: string) =>
    request<{ devices: { endpoint: string; device: string }[] }>('POST', '/push/subscribe', { subscription, device }),
  pushUnsubscribe: (endpoint: string) =>
    request<{ devices: { endpoint: string; device: string }[] }>('POST', '/push/unsubscribe', { endpoint }),
  pushTest: () => request<{ sent: number }>('POST', '/push/test', {}),
  terminals: () => request<TerminalSummary[]>('GET', '/terminals'),
  createTerminal: (cwd: string, command?: 'claude') => request<TerminalSummary>('POST', '/terminals', { cwd, command }),
  threadTerminal: (threadId: string) => request<TerminalSummary>('POST', `/threads/${encodeURIComponent(threadId)}/terminal`),
  deleteTerminal: (id: string) => request<void>('DELETE', `/terminals/${id}`),
  setConfig: (id: string, configId: string, value: string | boolean) =>
    request<void>('POST', `/threads/${id}/config`, { configId, value }),
  deleteThread: (id: string) => request<void>('DELETE', `/threads/${id}`),
  run: (id: string, prompt: string, attachments: string[] = []) =>
    request<{ runId: string }>('POST', `/threads/${id}/runs`, { prompt, attachments }),
  upload: async (id: string, files: File[]): Promise<UploadedFile[]> => {
    const form = new FormData();
    for (const f of files) form.append('files', f, f.name);
    const res = await fetch(`/api/threads/${id}/uploads`, {
      method: 'POST',
      headers: memoryToken ? { authorization: `Bearer ${memoryToken}` } : {},
      body: form,
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new ApiError(res.status, data.error ?? `Errore ${res.status}`);
    }
    return res.json();
  },
  cancel: (id: string) => request<void>('POST', `/threads/${id}/cancel`),
  respondPermission: (id: string, requestId: string, optionId: string | null) =>
    request<void>('POST', `/threads/${id}/permissions/${requestId}`, { optionId }),
};

/**
 * Segue gli eventi di una conversazione. Si ricollega da solo (rete che cade,
 * telefono in standby) ripartendo dall'ultimo evento ricevuto.
 */
export function followEvents(
  threadId: string,
  onEvent: (event: BaseEvent) => void,
  onConnection: (connected: boolean) => void,
): () => void {
  const abort = new AbortController();
  let lastId = -1;
  let delay = 1000;

  (async () => {
    while (!abort.signal.aborted) {
      try {
        const res = await fetch(`/api/threads/${threadId}/events?after=${lastId}`, {
          headers: memoryToken ? { authorization: `Bearer ${memoryToken}` } : {},
          signal: abort.signal,
        });
        if (res.status === 404 || res.status === 401) return;
        if (!res.ok || !res.body) throw new Error(`SSE ${res.status}`);
        onConnection(true);
        delay = 1000;
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += value;
          let sep: number;
          while ((sep = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            let data = '';
            let id: number | null = null;
            let event = 'message';
            for (const line of block.split('\n')) {
              if (line.startsWith('data:')) data += line.slice(5).trimStart();
              else if (line.startsWith('id:')) id = Number(line.slice(3).trim());
              else if (line.startsWith('event:')) event = line.slice(6).trim();
            }
            if (event !== 'message' || !data) continue;
            if (id !== null) lastId = id;
            onEvent(JSON.parse(data));
          }
        }
      } catch {
        if (abort.signal.aborted) return;
      }
      onConnection(false);
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 15000);
    }
  })();

  return () => abort.abort();
}

/** Token in uso (anche se il browser non permette di salvarlo) */
export function currentToken(): string {
  return memoryToken;
}
