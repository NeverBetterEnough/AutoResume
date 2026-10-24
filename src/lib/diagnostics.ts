import { version } from '../../package.json';
export const DIAGNOSTICS_KEY = 'resumePilot.diagnostics.v1';
export type Diagnostic = {
  id: string;
  time: string;
  version: string;
  context: string;
  stage: string;
  level: 'info' | 'error';
  details: unknown;
};
let queue = Promise.resolve();
const secrets = new Set<string>();
export function rememberSecrets(values: string[]) {
  for (const value of values) if (value.trim()) secrets.add(value.trim());
}
export function errorDetails(error: unknown): Record<string, unknown> {
  if (error instanceof Error)
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      ...('code' in error ? { code: error.code } : {}),
      ...(error.cause ? { cause: errorDetails(error.cause) } : {}),
    };
  return { message: typeof error === 'string' ? error : String(error) };
}
export function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[truncated]';
  if (typeof value === 'string') {
    let safe = value;
    for (const secret of secrets) safe = safe.split(secret).join('[REDACTED]');
    return safe
      .replace(/Bearer\s+[^\s,;"'<>]+/gi, 'Bearer [REDACTED]')
      .replace(/\bsk-[a-zA-Z0-9_-]{8,}\b/g, '[REDACTED]')
      .replace(/https?:\/\/[^\s"'<>]+/g, (raw) => {
        try {
          const url = new URL(raw);
          url.search = '';
          url.hash = '';
          url.username = '';
          url.password = '';
          return url.href;
        } catch {
          return '[URL]';
        }
      })
      .slice(0, 6000);
  }
  if (Array.isArray(value)) return value.slice(0, 40).map((item) => sanitize(item, depth + 1));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 40)
        .map(([key, item]) => [
          key,
          /api.?key|authorization|password|base64|resume.?text|prompt|^token$|^content$/i.test(key)
            ? '[REDACTED]'
            : sanitize(item, depth + 1),
        ]),
    );
  return value;
}
export async function readDiagnostics(): Promise<Diagnostic[]> {
  const keys = [DIAGNOSTICS_KEY, `${DIAGNOSTICS_KEY}.background`, `${DIAGNOSTICS_KEY}.sidepanel`];
  const values =
    typeof chrome !== 'undefined' && chrome.storage?.local
      ? await chrome.storage.local.get(keys)
      : Object.fromEntries(keys.map((key) => [key, JSON.parse(localStorage.getItem(key) || '[]')]));
  return keys
    .flatMap((key) => (Array.isArray(values[key]) ? values[key] : []))
    .filter((entry) => entry && typeof entry.id === 'string')
    .sort((a, b) => a.time.localeCompare(b.time))
    .slice(-160);
}
export function recordDiagnostic(
  context: string,
  stage: string,
  details: unknown,
  level: Diagnostic['level'] = 'info',
): Promise<void> {
  const entry: Diagnostic = {
    id: crypto.randomUUID(),
    time: new Date().toISOString(),
    version,
    context,
    stage,
    level,
    details: sanitize(details),
  };
  queue = queue
    .catch(() => {})
    .then(async () => {
      // Separate writers by context so UI logs cannot overwrite background errors.
      const key = `${DIAGNOSTICS_KEY}.${context === 'background' ? 'background' : 'sidepanel'}`;
      const stored =
        typeof chrome !== 'undefined' && chrome.storage?.local
          ? (await chrome.storage.local.get(key))[key]
          : JSON.parse(localStorage.getItem(key) || '[]');
      const entries = [...(Array.isArray(stored) ? stored : []), entry].slice(-80);
      if (typeof chrome !== 'undefined' && chrome.storage?.local)
        await chrome.storage.local.set({ [key]: entries });
      else {
        localStorage.setItem(key, JSON.stringify(entries));
        window.dispatchEvent(new Event('pilot-diagnostics'));
      }
    })
    .catch(() => {
      console.warn('[Resume Pilot] diagnostic storage unavailable', entry);
    });
  return queue;
}
export function captureError(
  context: string,
  stage: string,
  error: unknown,
  details: Record<string, unknown> = {},
) {
  return recordDiagnostic(context, stage, { ...details, error: errorDetails(error) }, 'error');
}
export function installErrorCapture(context: string) {
  globalThis.addEventListener('error', (event) => {
    const error = event as ErrorEvent;
    void captureError(context, 'uncaught.error', error.error || error.message, {
      file: error.filename,
      line: error.lineno,
      column: error.colno,
    });
  });
  globalThis.addEventListener('unhandledrejection', (event) => {
    void captureError(context, 'uncaught.promise', (event as PromiseRejectionEvent).reason);
  });
}
