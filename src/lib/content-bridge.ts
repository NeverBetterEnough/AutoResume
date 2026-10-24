import { version } from '../../package.json';
import { createPageAgent } from './page';
type Bridge = {
  version: string;
  runtime: typeof chrome.runtime;
  isAlive?: () => boolean;
  dispose: () => void;
};
declare global {
  interface Window {
    __resumePilotBridge?: Bridge;
    __resumePilotInstalled?: boolean;
  }
}
export function installContentBridge() {
  const runtime = typeof chrome !== 'undefined' ? chrome.runtime : undefined;
  const runtimeId = runtime?.id;
  if (!runtimeId || !runtime?.onMessage?.addListener)
    throw new Error(
      '[PAGE_RUNTIME_UNAVAILABLE] 页面脚本没有有效的扩展 runtime，无法建立消息连接。',
    );
  const previous = window.__resumePilotBridge;
  if (previous?.version === version && previous.runtime === runtime) {
    try {
      if (previous.isAlive?.()) return;
    } catch {
      /* Runtime invalidated after extension reload. */
    }
  }
  try {
    previous?.dispose();
  } catch {
    /* Previous runtime can already be invalidated. */
  }
  const agent = createPageAgent(document);
  const listener: Parameters<typeof runtime.onMessage.addListener>[0] = (
    message,
    sender,
    sendResponse,
  ) => {
    // Capture the ID once; an invalidated chrome.runtime may later become undefined.
    if (
      sender?.id !== runtimeId ||
      typeof message?.type !== 'string' ||
      !message.type.startsWith('page.')
    )
      return;
    const run = async () => {
      if (message.type === 'page.ping')
        return { version, runtimeId, documentId: agent.documentId, url: location.href };
      if (message.type === 'page.observe') return agent.observe();
      if (message.type === 'page.stop') {
        agent.stop();
        return null;
      }
      if (message.type === 'page.execute')
        return agent.execute(message.documentId, message.snapshot, message.actions, message.resume);
      throw new Error('未知页面命令');
    };
    void run().then(
      (data) => {
        try {
          sendResponse({ ok: true, data });
        } catch {
          /* Sender closed. */
        }
      },
      (error) => {
        try {
          sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        } catch {
          /* Sender closed. */
        }
      },
    );
    return true;
  };
  runtime.onMessage.addListener(listener);
  window.__resumePilotBridge = {
    version,
    runtime,
    isAlive: () => runtime.onMessage.hasListener(listener),
    dispose: () => {
      agent.stop();
      runtime.onMessage.removeListener(listener);
    },
  };
  window.__resumePilotInstalled = true;
}
