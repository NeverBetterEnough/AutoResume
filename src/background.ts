import type { Action, ActionResult, AgentCommand, Reply, Run, Snapshot } from './types';
import { createPlan, completion, validateActions } from './lib/provider';
import { patchData, readData, readRun, saveRun } from './lib/storage';
import { readPageSnapshot as observe } from './lib/browser';
import {
  captureError,
  installErrorCapture,
  recordDiagnostic,
  rememberSecrets,
} from './lib/diagnostics';
import { version } from '../package.json';

installErrorCapture('background');
void Promise.all([
  chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
  chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }),
]).catch((error) => captureError('background', 'initialize.failed', error));
// Bind the toolbar gesture to the actual tab and open synchronously while the
// browser user gesture is still active; do not rely on side-panel focus.
chrome.action.onClicked.addListener((tab) => {
  if (!tab || !Number.isInteger(tab.id) || !Number.isInteger(tab.windowId)) {
    void recordDiagnostic(
      'background',
      'toolbar.tab.missing',
      { tabId: tab?.id, windowId: tab?.windowId },
      'error',
    );
    return;
  }
  void chrome.sidePanel
    .open({ windowId: tab.windowId })
    .catch((error) => captureError('background', 'toolbar.open.failed', error));
  void recordDiagnostic('background', 'toolbar.open', {
    tabId: tab.id,
    windowId: tab.windowId,
    url: tab.url,
  });
});
void recordDiagnostic('background', 'initialize.ok', {
  version,
  runtimeId: chrome.runtime?.id,
  userAgent: navigator.userAgent,
});
let current: Run | undefined;
let controller: AbortController | undefined;
let busy = false;
const active = new Set(['observing', 'planning', 'executing', 'verifying']);
async function log(run: Run, message: string) {
  run.logs.push({ time: new Date().toISOString(), message });
  await saveRun(run);
}
async function page<T>(tabId: number, message: object): Promise<T> {
  const result: Reply<T> = await chrome.tabs.sendMessage(tabId, message, { frameId: 0 });
  if (!result || typeof result.ok !== 'boolean')
    throw new Error('页面未返回有效结果，请重新启动任务');
  if (!result.ok) throw new Error(result.error);
  return result.data;
}
function assertRunning(run: Run) {
  if (controller?.signal.aborted || current?.id !== run.id || run.status === 'stopped')
    throw new Error('任务已停止');
}
async function finish(run: Run) {
  const data = await readData();
  const filled = new Set(run.results.filter((r) => r.status === 'filled').map((r) => r.fieldId))
    .size;
  await patchData({
    history: [
      {
        id: run.id,
        title: run.snapshot?.title || '未知页面',
        url: run.snapshot?.url || '',
        time: run.startedAt,
        filled,
        missing: run.plan?.missing.length || 0,
        status: run.status,
      },
      ...data.history.filter((h) => h.id !== run.id),
    ].slice(0, 50),
  });
  await saveRun(run);
}
async function execute(run: Run, actions: Action[]) {
  assertRunning(run);
  const data = await readData();
  if (!run.snapshot) throw new Error('缺少页面快照，请重新开始');
  run.status = 'executing';
  await log(run, `正在填写 ${actions.length} 个字段…`);
  assertRunning(run);
  const validated = validateActions(actions, run.snapshot, data);
  const results = await page<ActionResult[]>(run.tabId, {
    type: 'page.execute',
    documentId: run.documentId,
    snapshot: run.snapshot,
    actions: validated,
    resume: data.resumes.find((r) => r.id === data.activeResumeId),
  });
  assertRunning(run);
  run.results.push(...results);
  run.status = 'verifying';
  await log(
    run,
    `本轮成功 ${results.filter((r) => r.status === 'filled').length} 项，检查页面变化…`,
  );
  const next = await observe(run.tabId);
  assertRunning(run);
  if (next.documentId !== run.documentId || next.url !== run.snapshot.url)
    throw new Error('页面已导航，请在新页面重新启动');
  run.snapshot = next;
  return results;
}
async function cycle(run: Run) {
  const data = await readData();
  let previousSignature = '';
  while (run.round < data.settings.maxRounds) {
    assertRunning(run);
    const snapshot = run.snapshot!;
    if (!snapshot.fields.length) {
      run.status = 'done';
      await log(run, '当前页面没有可填写字段。若表单尚未加载，加载完成后重新启动。');
      break;
    }
    const signature = JSON.stringify(snapshot.fields.map((f) => [f.id, f.value, f.options]));
    if (signature === previousSignature) {
      run.status = 'done';
      await log(run, '页面没有变化，已停止重复尝试。可编辑方案后手动重试。');
      break;
    }
    previousSignature = signature;
    run.round++;
    run.status = 'planning';
    await log(run, `第 ${run.round} 轮：结合职位、简历与知识库制定计划…`);
    const previousSuggestions = run.plan?.suggestions || [];
    await recordDiagnostic('background', 'model.plan.begin', {
      runId: run.id,
      round: run.round,
      provider: data.settings.provider,
      model: data.settings.providers[data.settings.provider].model,
      fieldCount: snapshot.fields.length,
    });
    run.plan = await createPlan(data, snapshot, controller!.signal, run.results);
    run.plan.suggestions = [...previousSuggestions, ...run.plan.suggestions]
      .filter(
        (s, i, all) =>
          all.findIndex((other) => other.title === s.title && other.content === s.content) === i,
      )
      .slice(0, 20);
    run.proposedActions = [
      ...(run.proposedActions || []).filter(
        (a) => !run.plan!.actions.some((next) => next.fieldId === a.fieldId),
      ),
      ...run.plan.actions,
    ];
    assertRunning(run);
    if (!run.plan.actions.length) {
      run.status = 'done';
      await log(run, '可填写项已处理；资料不足的字段已列出。');
      break;
    }
    if (!data.settings.autoFill) {
      run.status = 'review';
      await log(run, '计划已生成，等待你检查并执行选中项。');
      break;
    }
    const results = await execute(run, run.plan.actions);
    if (!results.some((r) => r.status === 'filled')) {
      run.status = 'done';
      await log(run, '本轮未成功写入字段，请检查执行记录。');
      break;
    }
    if (
      !run.snapshot!.fields.some(
        (f) => !f.value && !results.some((r) => r.fieldId === f.id && r.status === 'filled'),
      )
    ) {
      run.status = 'done';
      await log(run, '当前页面填写完成。请检查内容后手动进入下一步或提交。');
      break;
    }
  }
  if (active.has(run.status)) {
    run.status = 'done';
    await log(run, '已达到本次轮数上限。请检查待补充项，需要时重新启动。');
  }
  await finish(run);
}
async function start(tabId: number) {
  const data = await readData();
  rememberSecrets(Object.values(data.settings.providers).map((config) => config.apiKey));
  await recordDiagnostic('background', 'agent.start', {
    tabId,
    provider: data.settings.provider,
    model: data.settings.providers[data.settings.provider].model,
    hasResume: !!data.activeResumeId,
    knowledgeCount: data.knowledge.length,
  });
  if (!data.settings.providers[data.settings.provider].apiKey)
    throw new Error('请先配置模型 API Key');
  if (
    !data.resumes.some((r) => r.id === data.activeResumeId) &&
    !Object.values(data.profile).some(Boolean) &&
    !data.knowledge.length
  )
    throw new Error('请先上传简历或补充个人资料、知识库');
  controller = new AbortController();
  const run: Run = {
    id: crypto.randomUUID(),
    tabId,
    status: 'observing',
    round: 0,
    results: [],
    logs: [],
    startedAt: new Date().toISOString(),
  };
  current = run;
  try {
    await log(run, '正在识别当前页面的职位、字段及填写约束…');
    run.snapshot = await observe(tabId);
    run.documentId = run.snapshot.documentId;
    assertRunning(run);
    await cycle(run);
  } catch (error) {
    await fail(run, error);
  }
  return run.id;
}
async function fail(run: Run, error: unknown) {
  await captureError('background', 'agent.failed', error, {
    runId: run.id,
    tabId: run.tabId,
    status: run.status,
    round: run.round,
  });
  if (controller?.signal.aborted || run.status === 'stopped') {
    run.status = 'stopped';
    await log(run, '任务已停止。已写入的内容保留在页面。');
  } else {
    run.status = 'error';
    run.error = error instanceof Error ? error.message : '未知错误';
    await log(run, run.error);
  }
  await finish(run);
}
chrome.runtime.onMessage.addListener((message: AgentCommand, sender, sendResponse) => {
  // Only extension pages can invoke privileged model and storage operations.
  if (
    !chrome.runtime?.id ||
    sender?.id !== chrome.runtime.id ||
    !sender.url?.startsWith(chrome.runtime.getURL(''))
  )
    return;
  const handle = async () => {
    if (message.type === 'page.connect') {
      if (busy) throw new Error('Agent 正在运行，请先停止再重新连接页面。');
      const snapshot = await observe(message.tabId);
      return {
        tabId: message.tabId,
        url: snapshot.url,
        title: snapshot.title,
        fieldCount: snapshot.fields.length,
        documentId: snapshot.documentId,
        version,
      };
    }
    if (message.type === 'provider.test') {
      rememberSecrets([message.config.apiKey]);
      return completion(
        message.config,
        [{ role: 'user', content: 'Reply with OK.' }],
        undefined,
        false,
      ).then(() => '连接成功');
    }
    if (message.type === 'agent.stop') {
      if (current && current.id === message.runId) {
        controller?.abort();
        current.status = 'stopped';
        await page(current.tabId, { type: 'page.stop' }).catch(() => {});
        await log(current, '已请求停止，正在结束当前操作。');
      }
      return null;
    }
    if (busy) throw new Error('已有任务正在运行，请先停止或等待完成');
    busy = true;
    try {
      if (message.type === 'agent.start') return await start(message.tabId);
      if (message.type === 'agent.execute') {
        const run = current || (await readRun());
        if (!run || run.id !== message.runId || !['review', 'done'].includes(run.status))
          throw new Error('执行计划已失效，请重新分析');
        current = run;
        controller = new AbortController();
        try {
          await execute(run, message.actions);
          run.status = 'done';
          await log(run, '已执行选中方案，请检查页面。');
          await finish(run);
        } catch (error) {
          await fail(run, error);
        }
        return run.id;
      }
      throw new Error('未知命令');
    } finally {
      busy = false;
    }
  };
  // Streaming responses plus periodic extension API calls keep a long planning round alive.
  const keepAlive = setInterval(() => {
    void chrome.runtime
      .getPlatformInfo()
      .catch((error) => captureError('background', 'keepalive.failed', error));
  }, 20000);
  const respond = (reply: Reply) => {
    try {
      sendResponse(reply);
    } catch (error) {
      void captureError('background', 'reply.failed', error, { command: message?.type });
    }
  };
  handle()
    .then((data) => respond({ ok: true, data }))
    .catch(async (error) => {
      await captureError('background', 'command.failed', error, { command: message?.type });
      respond({ ok: false, error: error instanceof Error ? error.message : String(error) });
    })
    .finally(() => clearInterval(keepAlive));
  return true;
});
// Do not silently resume writing after a service-worker/browser restart.
void readRun()
  .then(async (run) => {
    if (run && active.has(run.status) && !current) {
      run.status = 'stopped';
      run.logs.push({
        time: new Date().toISOString(),
        message: '后台已重启，任务已中断。请检查页面后重新启动。',
      });
      await saveRun(run);
    }
  })
  .catch((error) => captureError('background', 'restore.failed', error));
