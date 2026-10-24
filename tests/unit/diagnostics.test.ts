import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  captureError,
  readDiagnostics,
  rememberSecrets,
  sanitize,
} from '../../src/lib/diagnostics';
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('chrome', undefined);
});
afterEach(() => vi.unstubAllGlobals());
describe('local diagnostics', () => {
  it('stores stage, error stack and nested cause while redacting keys and URL parameters', async () => {
    rememberSecrets(['private-zhipu.key123']);
    await captureError(
      'background',
      'script.inject.failed',
      new Error('runtime failed private-zhipu.key123', {
        cause: new TypeError("Cannot read properties of undefined (reading 'id')"),
      }),
      { tabId: 7, url: 'https://jobs.example/apply?token=private#secret', apiKey: 'another-key' },
    );
    const log = JSON.stringify(await readDiagnostics());
    expect(log).toContain('script.inject.failed');
    expect(log).toContain('TypeError');
    expect(log).toContain('stack');
    expect(log).not.toContain('private-zhipu.key123');
    expect(log).not.toContain('another-key');
    expect(log).not.toContain('token=private');
    expect(log).not.toContain('#secret');
  });
  it('removes private payload fields from nested diagnostic metadata', () => {
    const log = JSON.stringify(
      sanitize({
        nested: {
          authorization: 'Bearer secret',
          base64: 'raw-file',
          prompt: 'resume-facts',
          content: 'answer',
        },
      }),
    );
    for (const secret of ['Bearer secret', 'raw-file', 'resume-facts', 'answer'])
      expect(log).not.toContain(secret);
  });
});
