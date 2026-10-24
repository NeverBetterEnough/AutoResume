import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertApplicationTab,
  getActiveTab,
  PAGE_PERMISSION_HINT,
  readPageSnapshot,
  requestSiteAccess,
} from '../../src/lib/browser';
import { version } from '../../package.json';
import { readDiagnostics } from '../../src/lib/diagnostics';

const get = vi.fn();
const query = vi.fn();
const executeScript = vi.fn();
const sendMessage = vi.fn();
const request = vi.fn();
const snapshot = {
  documentId: 'document-1',
  url: 'https://jobs.example/apply',
  title: '申请',
  fields: [],
  context: '',
  warnings: [],
  capturedAt: '',
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('chrome', {
    runtime: { id: 'test-runtime' },
    permissions: { contains: vi.fn().mockResolvedValue(true), request },
    tabs: { get, query, sendMessage },
    scripting: { executeScript },
  });
  get.mockResolvedValue({ id: 7, windowId: 1, url: snapshot.url });
  executeScript.mockResolvedValue([]);
  sendMessage.mockImplementation(async (_id, message) => ({
    ok: true,
    data:
      message.type === 'page.ping'
        ? { version, runtimeId: 'test-runtime', documentId: snapshot.documentId }
        : snapshot,
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe('active page resolution', () => {
  it('does not dereference id when Chrome returns no active tab', async () => {
    query.mockResolvedValue([]);
    expect(await getActiveTab()).toBeUndefined();
    expect(() => assertApplicationTab(undefined)).toThrow('没有找到当前标签页');
    query.mockResolvedValue([undefined, { id: 7, windowId: 1 }]);
    expect((await getActiveTab())?.id).toBe(7);
  });

  it.each([
    'chrome://extensions/',
    'edge://extensions/',
    'chrome-extension://abc/sidepanel.html',
    'file:///resume.html',
  ])('rejects known restricted page %s without injecting a script', async (url) => {
    get.mockResolvedValue({ id: 7, windowId: 1, url });
    await expect(readPageSnapshot(7)).rejects.toThrow('当前选中的是浏览器内部页');
    expect(executeScript).not.toHaveBeenCalled();
  });

  it('does not misclassify absent URL metadata as an internal page', async () => {
    get.mockResolvedValue({ id: 7, windowId: 1 });
    executeScript.mockRejectedValue(
      new Error('Cannot access contents of the page. Extension manifest must request permission'),
    );
    await expect(readPageSnapshot(7)).rejects.toThrow(PAGE_PERMISSION_HINT);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('can read an authorized page even when tab metadata omits its URL', async () => {
    get.mockResolvedValue({ id: 7, windowId: 1 });
    await expect(readPageSnapshot(7)).resolves.toEqual(snapshot);
    expect(executeScript).toHaveBeenCalledOnce();
  });

  it('handles a tab closed between selecting and reading it', async () => {
    get.mockRejectedValue(new Error('No tab with id: 7'));
    await expect(readPageSnapshot(7)).rejects.toThrow('目标标签页已关闭或已失效');
    expect(executeScript).not.toHaveBeenCalled();
  });

  it('handles missing content-script replies instead of dereferencing them', async () => {
    sendMessage.mockResolvedValue(undefined);
    await expect(readPageSnapshot(7)).rejects.toThrow('页面没有返回有效的读取结果');
  });
  it('retains the exact injected TypeError and its stack instead of reporting a permission error', async () => {
    const original = new Error(
      "Uncaught TypeError: Cannot read properties of undefined (reading 'id')",
    );
    executeScript.mockRejectedValue(original);
    const error = await readPageSnapshot(7).catch((error) => error as Error);
    expect((error as Error).message).toContain('CONTENT_SCRIPT_RUNTIME_ERROR');
    expect((error as Error).message).toContain("reading 'id'");
    expect((error as Error).cause).toBe(original);
    const entries = await readDiagnostics();
    const failure = entries.findLast((entry) => entry.stage === 'script.inject.failed');
    expect(JSON.stringify(failure)).toContain('reading');
    expect(JSON.stringify(failure)).toContain('stack');
    expect((error as Error).message).not.toContain(PAGE_PERMISSION_HINT);
  });
  it('detects a stale content script during the handshake', async () => {
    sendMessage.mockResolvedValue({
      ok: true,
      data: { version: '0.1.0', runtimeId: 'test-runtime' },
    });
    await expect(readPageSnapshot(7)).rejects.toThrow('CONTENT_VERSION_MISMATCH');
  });
  it('requests only the selected site directly in the click call stack', async () => {
    request.mockResolvedValue(true);
    const result = requestSiteAccess({
      id: 7,
      url: 'https://jobs.example/apply?token=private',
    } as chrome.tabs.Tab);
    expect(request).toHaveBeenCalledWith({ origins: ['https://jobs.example/*'] });
    expect(await result).toBe(true);
  });
});
