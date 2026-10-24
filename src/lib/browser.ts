import type { Reply, Snapshot } from '../types';
import { version } from '../../package.json';
import { captureError, recordDiagnostic } from './diagnostics';

export const PAGE_PERMISSION_HINT =
  '浏览器拒绝读取当前站点。请点击「连接当前页面」并允许该站点权限后重试。';

export class PageConnectionError extends Error {
  constructor(
    public code: string,
    message: string,
    cause?: unknown,
  ) {
    super(`[${code}] ${message}`, { cause });
    this.name = 'PageConnectionError';
  }
}
export function sitePattern(tab: chrome.tabs.Tab): string {
  assertApplicationTab(tab);
  const url = tab.url || tab.pendingUrl;
  if (!url)
    throw new PageConnectionError(
      'TAB_URL_UNAVAILABLE',
      '无法读取当前标签页地址。请确认已更新扩展并允许其标签页元数据权限。',
    );
  const parsed = new URL(url);
  return `${parsed.protocol}//${parsed.hostname}/*`;
}
// Invoke directly from a click handler, before awaiting other operations.
export function requestSiteAccess(tab: chrome.tabs.Tab): Promise<boolean> {
  return chrome.permissions.request({ origins: [sitePattern(tab)] });
}
export function classifyInjectionError(error: unknown): { code: string; message: string } {
  const text = error instanceof Error ? error.message : String(error);
  if (
    /TypeError|ReferenceError|SyntaxError|reading ['"]id['"]|not defined|is not a function/i.test(
      text,
    )
  )
    return { code: 'CONTENT_SCRIPT_RUNTIME_ERROR', message: `页面脚本执行出错：${text}` };
  if (/Extension context invalidated|context.*destroyed/i.test(text))
    return {
      code: 'EXTENSION_CONTEXT_INVALIDATED',
      message: '旧的扩展上下文已失效，请关闭旧侧边栏并重新打开；诊断日志已保留原始异常。',
    };
  if (/No tab|tab.*closed|No frame|frame.*removed/i.test(text))
    return { code: 'TAB_OR_FRAME_GONE', message: `目标标签页或页面框架已变化：${text}` };
  if (
    /Cannot access|missing host permission|must request permission|not allowed.*access|permission denied/i.test(
      text,
    )
  )
    return { code: 'SITE_ACCESS_DENIED', message: PAGE_PERMISSION_HINT };
  return { code: 'SCRIPT_INJECTION_FAILED', message: `注入页面脚本失败：${text}` };
}
async function pageRequest<T>(tabId: number, type: string, timeoutMs = 12000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const reply = await Promise.race([
      chrome.tabs.sendMessage(tabId, { type }, { frameId: 0 }) as Promise<Reply<T> | undefined>,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new PageConnectionError(
                'PAGE_RESPONSE_TIMEOUT',
                `${type} 超过 ${timeoutMs / 1000} 秒未响应`,
              ),
            ),
          timeoutMs,
        );
      }),
    ]);
    if (!reply || typeof reply.ok !== 'boolean')
      throw new PageConnectionError(
        'PAGE_REPLY_INVALID',
        '页面没有返回有效的读取结果，请查看诊断日志。',
      );
    if (!reply.ok) throw new PageConnectionError('PAGE_COMMAND_FAILED', reply.error);
    return reply.data;
  } finally {
    clearTimeout(timer);
  }
}

export async function getActiveTab(diagnose = false): Promise<chrome.tabs.Tab | undefined> {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const tab = tabs?.find((tab) => tab && Number.isInteger(tab.id) && tab.id! >= 0);
  if (diagnose)
    await recordDiagnostic('sidepanel', 'tab.resolve', {
      tabId: tab?.id,
      windowId: tab?.windowId,
      url: tab?.url,
      status: tab?.status,
      resultCount: tabs?.length,
    });
  return tab;
}

export function assertApplicationTab(
  tab: chrome.tabs.Tab | undefined,
): asserts tab is chrome.tabs.Tab & { id: number } {
  if (!tab || !Number.isInteger(tab.id) || tab.id! < 0) {
    throw new PageConnectionError(
      'ACTIVE_TAB_NOT_FOUND',
      '没有找到当前标签页，请切换到招聘网页后重试。',
    );
  }
  const url = tab.url || tab.pendingUrl;
  // Chrome omits URL metadata without activeTab/host permission. An absent URL
  // does not establish that this is an internal browser page.
  if (url && !/^https?:\/\//i.test(url)) {
    throw new PageConnectionError(
      'UNSUPPORTED_PAGE',
      '当前选中的是浏览器内部页、扩展页或本地文件，无法自动填写。请先切换到 HTTP / HTTPS 招聘申请页面，再点击工具栏中的 Resume Pilot 图标。',
    );
  }
}

export async function readPageSnapshot(tabId: number): Promise<Snapshot> {
  if (!Number.isInteger(tabId) || tabId < 0)
    throw new Error('当前标签页无效，请重新选择招聘网页。');
  let tab: chrome.tabs.Tab | undefined;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch (error) {
    await captureError('background', 'tab.get.failed', error, { tabId });
    throw new PageConnectionError(
      'TARGET_TAB_GONE',
      '目标标签页已关闭或已失效，请切换到招聘网页后重新启动。',
      error,
    );
  }
  assertApplicationTab(tab);
  let granted: boolean | undefined;
  if (tab.url)
    granted = await chrome.permissions
      .contains({ origins: [sitePattern(tab)] })
      .catch(() => undefined);
  await recordDiagnostic('background', 'script.inject.begin', {
    tabId,
    windowId: tab.windowId,
    url: tab.url,
    status: tab.status,
    persistentSitePermission: granted,
  });
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'ISOLATED',
      files: ['content.js'],
    });
    await recordDiagnostic('background', 'script.inject.ok', {
      tabId,
      frames: results?.map((item) => ({ frameId: item.frameId, documentId: item.documentId })),
    });
  } catch (error) {
    const failure = classifyInjectionError(error);
    await captureError('background', 'script.inject.failed', error, {
      tabId,
      url: tab.url,
      code: failure.code,
      persistentSitePermission: granted,
    });
    throw new PageConnectionError(failure.code, failure.message, error);
  }
  try {
    const pong = await pageRequest<{ version: string; runtimeId: string; documentId: string }>(
      tabId,
      'page.ping',
      5000,
    );
    await recordDiagnostic('background', 'page.handshake', { tabId, ...pong });
    if (pong.version !== version || pong.runtimeId !== chrome.runtime?.id)
      throw new PageConnectionError(
        'CONTENT_VERSION_MISMATCH',
        `页面脚本版本 ${pong.version || 'unknown'} 与扩展 ${version} 不一致，请刷新网页后重新连接。`,
      );
    const snapshot = await pageRequest<Snapshot>(tabId, 'page.observe');
    if (!snapshot?.documentId || !Array.isArray(snapshot.fields))
      throw new PageConnectionError(
        'PAGE_SNAPSHOT_INVALID',
        '页面读取结果不完整，请查看诊断日志。',
      );
    await recordDiagnostic('background', 'page.observe.ok', {
      tabId,
      documentId: snapshot.documentId,
      url: snapshot.url,
      fieldCount: snapshot.fields.length,
      warnings: snapshot.warnings,
    });
    return snapshot;
  } catch (error) {
    await captureError('background', 'page.connect.failed', error, { tabId, url: tab.url });
    throw error instanceof PageConnectionError
      ? error
      : new PageConnectionError(
          'PAGE_MESSAGE_FAILED',
          `页面消息连接失败：${error instanceof Error ? error.message : String(error)}`,
          error,
        );
  }
}
