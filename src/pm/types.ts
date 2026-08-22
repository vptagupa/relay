// Project-management provider PLUGIN contract. A provider is added by dropping a module in `src/pm/` that
// implements `PmProvider` and registering it in `src/pm/index.ts` — the generic IPC, preload, sidebar rail, and
// settings form NEVER change. Everything a provider does DIFFERENTLY — how it authenticates, what it needs to
// connect, what it calls a "project", which fields you can edit, what it can do — is declared here as DATA, so
// the generic layers branch on the declaration, never on a provider id. That is what makes a new integration
// (Jira, Linear, Asana, Trello, ClickUp…) drop in without touching shared code.

export interface PmResult<T = unknown> { ok: boolean; status: number; data?: T; error?: string; code?: string }

// A container of tasks. Different providers name it differently (Project, Board, Team, Space) — the provider
// declares the noun via `PmProvider.containerLabel`, so the rail reads naturally without special-casing.
export interface PmProject { id: string; title: string; subtitle?: string }

// A NORMALIZED task. The core fields the rail renders for every provider; `extra` carries provider-specific
// display-only fields (rendered generically as label/value) so one provider's quirks never leak into the shape.
export interface PmTask {
  id: string; key: string; title: string;
  status?: string; statusOptions?: string[];           // inline options → the status editor needs no extra call
  priority?: string; assignee?: string;
  deadline?: string; url?: string; description?: string;
  extra?: Array<{ label: string; value: string }>;
}
export interface PmRef { id: string; title: string }

// One field the generic task editor can render + write back. `control` picks the widget; `optionsRef` names a
// reference() list (or the task's inline statusOptions) to fill a select. The plugin lists what IT supports;
// the editor renders exactly those, so two-way editing works across providers with different field sets.
export interface EditField {
  key: string;                                          // the patch key sent to updateTask()
  label: string;
  control: 'select' | 'text' | 'date' | 'number';
  optionsRef?: string;                                  // reference() list name for a select (else inline statusOptions)
}

// One input the generic settings form renders to connect this provider (hosts, client id/secret, an API token…).
// `url: true` fields are validated to start with http(s):// and have trailing slashes stripped on save, so a
// host typed without a scheme or with a trailing slash can't silently break request URLs.
export interface ConfigField { key: string; label: string; placeholder?: string; secret?: boolean; required?: boolean; url?: boolean; help?: string }

// What getConfig returns to the renderer: non-secret values echoed back, secrets reduced to a boolean, plus the
// derived "configured" flag and (for OAuth) the exact loopback redirect URI the user must register.
export interface PmConfig { fields: Record<string, string>; hasSecrets: Record<string, boolean>; configured: boolean; redirectUri?: string }

// One filter the rail's filter bar renders. `control` picks the widget; a select's options come from `optionsRef`
// (a reference() list). The plugin maps the chosen values → its own query in tasks(); the UI stays generic.
export interface PmFilter {
  key: string;                                          // the filter key handed to tasks({ filters })
  label: string;
  control: 'text' | 'select';
  optionsRef?: string;                                  // reference() list name for a select
  placeholder?: string;                                 // for a text filter
}

export interface PmCapabilities {
  createTask: boolean;
  editFields: EditField[];                              // drives the two-way task editor (empty = read-only)
  references: string[];                                 // reference() list names this provider serves
  filters: PmFilter[];                                  // drives the rail's filter bar (empty = no filters)
  paginated: boolean;                                   // tasks() honors limit/offset → the rail shows a pager
  canComment: boolean;                                  // postComment() is available → write-back posts a comment (else appends the description)
}

// The rail's task query: declared filter values + pagination. The plugin turns this into its own request.
export interface PmTaskQuery { filters?: Record<string, string>; limit?: number; offset?: number }

export type PmAuthKind = 'oauth-pkce' | 'oauth' | 'token';
// The auth sub-contract. `kind` is the ONLY thing the generic layer branches on: oauth/oauth-pkce run the shared
// loopback browser flow (PKCE adds a code_verifier); `token` skips the browser entirely (the token is a config
// field, so "connect" is just save-config + verify via authState).
export interface PmAuth {
  kind: PmAuthKind;
  port?: number; redirectUri?: string;                  // loopback OAuth only (oauth / oauth-pkce)
  scopesNote?: string;                                  // shown in the connect UI: what to register / where to get a token
  authorizeUrl?(ws: string, state: string, challenge?: string): Promise<string>;
  exchangeCode?(ws: string, code: string, verifier: string, redirectUri: string): Promise<{ ok: boolean; account?: string; error?: string }>;
  authState(ws: string): Promise<{ connected: boolean; account?: string }>;
  disconnect(ws: string): Promise<void>;
  getConfig(ws: string): Promise<PmConfig>;
  setConfig(ws: string, values: Record<string, string>): Promise<{ ok: boolean; error?: string }>;
}

export interface PmProvider {
  id: string; name: string; icon: string;               // identity (icon = one emoji for the rail/picker)
  containerLabel: string;                               // 'Project' | 'Board' | 'Team' | 'Space' …
  auth: PmAuth;
  configFields: ConfigField[];
  capabilities: PmCapabilities;
  projects(ws: string): Promise<PmResult<PmProject[]>>;
  tasks(ws: string, projectId: string, query?: PmTaskQuery): Promise<PmResult<PmTask[]>>;
  taskDetail(ws: string, idOrKey: string): Promise<PmResult<PmTask>>;
  createTask(ws: string, projectId: string, body: Record<string, unknown>): Promise<PmResult<{ id: string; key: string }>>;
  updateTask(ws: string, idOrKey: string, patch: Record<string, unknown>): Promise<PmResult<{ id: string; key: string }>>;
  reference(ws: string, name: string): Promise<PmResult<PmRef[]>>;
  postComment?(ws: string, idOrKey: string, body: string): Promise<PmResult<unknown>>; // append a comment on the task's thread (present iff capabilities.canComment)
}

// SAFE metadata sent to the renderer — no functions, no secrets — so the UI (picker + config form + editor)
// builds itself entirely from data. Adding a provider needs zero UI change because the UI reads this.
export interface PmProviderMeta {
  id: string; name: string; icon: string; containerLabel: string;
  authKind: PmAuthKind; scopesNote?: string;
  configFields: ConfigField[];
  capabilities: PmCapabilities;
}
export const pmMeta = (p: PmProvider): PmProviderMeta => ({
  id: p.id, name: p.name, icon: p.icon, containerLabel: p.containerLabel,
  authKind: p.auth.kind, scopesNote: p.auth.scopesNote,
  configFields: p.configFields, capabilities: p.capabilities,
});
