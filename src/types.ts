export type Provider = 'deepseek' | 'zhipu';
export type ProviderConfig = { apiKey: string; baseUrl: string; model: string };
export type Settings = {
  provider: Provider;
  providers: Record<Provider, ProviderConfig>;
  autoFill: boolean;
  allowCreative: boolean;
  maxRounds: number;
};
export type Knowledge = {
  id: string;
  title: string;
  content: string;
  category: string;
  keywords: string[];
  updatedAt: string;
};
export type Resume = {
  id: string;
  name: string;
  mime: string;
  base64: string;
  text: string;
  size: number;
  updatedAt: string;
};
export type Profile = {
  name: string;
  email: string;
  phone: string;
  city: string;
  position: string;
  website: string;
};
export type AppData = {
  version: 1;
  profile: Profile;
  knowledge: Knowledge[];
  resumes: Resume[];
  activeResumeId: string | null;
  settings: Settings;
  history: RunSummary[];
};
export type Field = {
  id: string;
  label: string;
  kind:
    | 'text'
    | 'textarea'
    | 'select'
    | 'radio'
    | 'checkbox'
    | 'file'
    | 'combobox'
    | 'contenteditable';
  type: string;
  value: string;
  required: boolean;
  options: { label: string; value: string }[];
  placeholder: string;
  maxLength: number;
  accept: string;
  section: string;
};
export type Snapshot = {
  documentId: string;
  url: string;
  title: string;
  context: string;
  fields: Field[];
  warnings: string[];
  capturedAt: string;
};
export type Action = {
  fieldId: string;
  value: string;
  source: 'profile' | 'resume' | 'knowledge' | 'generated';
  sourceId?: string;
  reason: string;
  confidence: number;
};
export type Missing = { fieldId: string; question: string };
export type Suggestion = { title: string; content: string; category: string; keywords: string[] };
export type Plan = {
  summary: string;
  actions: Action[];
  missing: Missing[];
  suggestions: Suggestion[];
};
export type ActionResult = {
  fieldId: string;
  status: 'filled' | 'skipped' | 'failed';
  message: string;
  value?: string;
};
export type RunStatus =
  | 'idle'
  | 'observing'
  | 'planning'
  | 'review'
  | 'executing'
  | 'verifying'
  | 'done'
  | 'stopped'
  | 'error';
export type RunLog = { time: string; message: string };
export type Run = {
  id: string;
  tabId: number;
  documentId?: string;
  status: RunStatus;
  round: number;
  snapshot?: Snapshot;
  plan?: Plan;
  proposedActions?: Action[];
  results: ActionResult[];
  logs: RunLog[];
  error?: string;
  startedAt: string;
};
export type RunSummary = {
  id: string;
  title: string;
  url: string;
  time: string;
  filled: number;
  missing: number;
  status: RunStatus;
};
export type AgentCommand =
  | { type: 'page.connect'; tabId: number }
  | { type: 'agent.start'; tabId: number }
  | { type: 'agent.execute'; runId: string; actions: Action[] }
  | { type: 'agent.stop'; runId: string }
  | { type: 'provider.test'; config: ProviderConfig };
export type Reply<T = unknown> = { ok: true; data: T } | { ok: false; error: string };
