import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installContentBridge } from '../../src/lib/content-bridge';
import { version } from '../../package.json';

const addListener = vi.fn();
const removeListener = vi.fn();
const hasListener = vi.fn();
beforeEach(() => {
  vi.resetAllMocks();
  hasListener.mockReturnValue(true);
  delete window.__resumePilotBridge;
  delete window.__resumePilotInstalled;
  vi.stubGlobal('chrome', {
    runtime: { id: 'bridge-runtime', onMessage: { addListener, removeListener, hasListener } },
  });
});
afterEach(() => {
  delete window.__resumePilotBridge;
  delete window.__resumePilotInstalled;
  vi.unstubAllGlobals();
});

describe('versioned content bridge', () => {
  it('reports an absent runtime without dereferencing undefined.id', () => {
    vi.stubGlobal('chrome', {});
    expect(() => installContentBridge()).toThrow('PAGE_RUNTIME_UNAVAILABLE');
  });
  it('ignores the old boolean installation flag and installs a working bridge', async () => {
    window.__resumePilotInstalled = true;
    installContentBridge();
    const listener = addListener.mock.calls[0][0];
    const reply = vi.fn();
    listener({ type: 'page.ping' }, { id: 'bridge-runtime' }, reply);
    await Promise.resolve();
    expect(reply).toHaveBeenCalledWith({
      ok: true,
      data: expect.objectContaining({ version, runtimeId: 'bridge-runtime' }),
    });
  });
  it('does not read chrome.runtime.id after the runtime is invalidated', async () => {
    installContentBridge();
    const listener = addListener.mock.calls[0][0];
    const reply = vi.fn();
    vi.stubGlobal('chrome', { runtime: undefined });
    expect(() => listener({ type: 'page.ping' }, { id: 'bridge-runtime' }, reply)).not.toThrow();
    await Promise.resolve();
    expect(reply).toHaveBeenCalledWith({
      ok: true,
      data: expect.objectContaining({ runtimeId: 'bridge-runtime' }),
    });
  });
  it('does not register duplicate listeners on repeated injection', () => {
    installContentBridge();
    installContentBridge();
    expect(addListener).toHaveBeenCalledOnce();
  });
  it('repairs an installation marker whose listener was removed on extension reload', () => {
    installContentBridge();
    hasListener.mockReturnValue(false);
    installContentBridge();
    expect(addListener).toHaveBeenCalledTimes(2);
    expect(removeListener).toHaveBeenCalledOnce();
  });
  it('replaces an old bridge even if disposing the invalidated runtime throws', () => {
    const dispose = vi.fn(() => {
      throw new Error('Extension context invalidated');
    });
    window.__resumePilotBridge = { version: '0.1.0', runtime: chrome.runtime, dispose };
    expect(() => installContentBridge()).not.toThrow();
    expect(dispose).toHaveBeenCalledOnce();
    expect(addListener).toHaveBeenCalledOnce();
  });
  it('ignores messages with no sender or from another extension', () => {
    installContentBridge();
    const listener = addListener.mock.calls[0][0];
    const reply = vi.fn();
    listener({ type: 'page.ping' }, undefined, reply);
    listener({ type: 'page.ping' }, { id: 'another-extension' }, reply);
    expect(reply).not.toHaveBeenCalled();
  });
});
