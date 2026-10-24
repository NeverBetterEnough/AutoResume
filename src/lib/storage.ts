import type { AppData, Run, Settings } from '../types';
export const DATA_KEY = 'resumePilot.data.v1';
export const RUN_KEY = 'resumePilot.run.v1';
export const HISTORY_KEY = 'resumePilot.history.v1';
export const defaults: Settings = {
  provider: 'deepseek',
  providers: {
    deepseek: { apiKey: '', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' },
    zhipu: { apiKey: '', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-5.3' },
  },
  autoFill: true,
  allowCreative: true,
  maxRounds: 3,
};
export function emptyData(): AppData {
  return {
    version: 1,
    profile: { name: '', email: '', phone: '', city: '', position: '', website: '' },
    knowledge: [],
    resumes: [],
    activeResumeId: null,
    settings: structuredClone(defaults),
    history: [],
  };
}
export const inExtension = () => typeof chrome !== 'undefined' && !!chrome.storage?.local;
export async function readData(): Promise<AppData> {
  const value = inExtension()
    ? (await chrome.storage.local.get(DATA_KEY))[DATA_KEY]
    : JSON.parse(localStorage.getItem(DATA_KEY) || 'null');
  const history = inExtension()
    ? (await chrome.storage.local.get(HISTORY_KEY))[HISTORY_KEY]
    : JSON.parse(localStorage.getItem(HISTORY_KEY) || 'null');
  const base = emptyData();
  return value
    ? {
        ...base,
        ...value,
        history: history || value.history || [],
        settings: {
          ...base.settings,
          ...value.settings,
          providers: { ...base.settings.providers, ...value.settings?.providers },
        },
      }
    : { ...base, history: history || [] };
}
// Only patch the fields owned by the caller; a running agent may update history concurrently.
export async function patchData(patch: Partial<AppData>): Promise<AppData> {
  const next = { ...(await readData()), ...patch, version: 1 as const };
  const { history, ...content } = next;
  const { history: newHistory, ...contentPatch } = patch;
  if (inExtension()) {
    const updates: Record<string, unknown> = {};
    if (Object.keys(contentPatch).length) updates[DATA_KEY] = content;
    if (newHistory) updates[HISTORY_KEY] = history;
    await chrome.storage.local.set(updates);
  } else {
    if (Object.keys(contentPatch).length) localStorage.setItem(DATA_KEY, JSON.stringify(content));
    if (newHistory) localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
    window.dispatchEvent(new Event('pilot-storage'));
  }
  return next;
}
export async function readRun(): Promise<Run | undefined> {
  return inExtension() ? (await chrome.storage.session.get(RUN_KEY))[RUN_KEY] : undefined;
}
export async function saveRun(run: Run) {
  await chrome.storage.session.set({ [RUN_KEY]: run });
}
export function subscribe(onData: () => void) {
  if (!inExtension()) {
    window.addEventListener('pilot-storage', onData);
    return () => window.removeEventListener('pilot-storage', onData);
  }
  const listener = (changes: Record<string, chrome.storage.StorageChange>) => {
    if (changes[DATA_KEY] || changes[RUN_KEY] || changes[HISTORY_KEY]) onData();
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
