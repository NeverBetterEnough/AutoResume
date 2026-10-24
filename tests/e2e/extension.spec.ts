import { test, expect, chromium } from '@playwright/test';
import { readFile, writeFile, mkdtemp, rm, mkdir, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { emptyData } from '../../src/lib/storage';

function samplePdf() {
  const stream = 'BT /F1 12 Tf 50 750 Td (Resume Pilot PDF text) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, i) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((n) => String(n).padStart(10, '0') + ' 00000 n ')
    .join('\n')}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
}

test('real MV3 extension observes, plans, fills, uploads and replans dynamic fields', async () => {
  const userData = await mkdtemp(path.join(tmpdir(), 'resume-pilot-test-'));
  const extensionPath = path.join(userData, 'extension');
  await cp(path.resolve('dist'), extensionPath, { recursive: true });
  const manifestPath = path.join(extensionPath, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  // Test-only host permission substitutes for a toolbar activeTab user gesture.
  manifest.host_permissions.push('http://127.0.0.1/*');
  await writeFile(manifestPath, JSON.stringify(manifest));
  const context = await chromium.launchPersistentContext(userData, {
    channel: 'chromium',
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  try {
    const runtimeErrors: string[] = [];
    context.on('weberror', (error) => runtimeErrors.push(error.error().message));
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker');
    const extensionId = new URL(worker.url()).hostname;
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await context.route('https://open.bigmodel.cn/api/paas/v4/chat/completions', async (route) => {
      const body = route.request().postDataJSON();
      const valid =
        body.model === 'glm-5.3' &&
        body.thinking?.type === 'enabled' &&
        body.reasoning_effort === 'low';
      await route.fulfill({
        status: valid ? 200 : 400,
        contentType: 'application/json',
        body: JSON.stringify(
          valid
            ? { choices: [{ message: { content: 'OK' } }] }
            : { error: { code: '1210', message: 'GLM-5.3 does not support disabled thinking' } },
        ),
      });
    });
    await panel.setViewportSize({ width: 420, height: 950 });
    await panel.getByRole('button', { name: '模型设置', exact: true }).click();
    await panel.getByRole('button', { name: /智谱 GLM/ }).click();
    await panel.getByLabel('API Key', { exact: true }).fill('zhipu-integration-test-key');
    await panel.getByRole('button', { name: '测试连接', exact: true }).click();
    await expect(panel.getByRole('status')).toContainText('模型连接成功');
    await panel.getByRole('button', { name: '投递工作台', exact: true }).click();
    const data = emptyData();
    data.profile = {
      name: '林晓',
      email: 'lin@example.com',
      phone: '13800138000',
      city: '上海',
      position: '前端工程师',
      website: '',
    };
    data.settings.providers.deepseek.apiKey = 'integration-test-key';
    data.knowledge = [
      {
        id: 'strengths',
        title: '个人优势',
        content: '熟悉 React 与 TypeScript，善于用组件化方法提升交付效率。',
        category: '个人优势',
        keywords: ['优势', 'React'],
        updatedAt: new Date().toISOString(),
      },
    ];
    data.resumes = [
      {
        id: 'resume-test',
        name: '林晓-简历.txt',
        mime: 'text/plain',
        base64: Buffer.from('林晓，本科学历，毕业于示例大学。').toString('base64'),
        text: '林晓，本科学历，毕业于示例大学。',
        size: 60,
        updatedAt: new Date().toISOString(),
      },
    ];
    data.activeResumeId = 'resume-test';
    await panel.evaluate(async (value) => {
      await chrome.storage.local.set({ 'resumePilot.data.v1': value });
    }, data);
    const calls: unknown[] = [];
    await context.route('https://api.deepseek.com/chat/completions', async (route) => {
      const payload = route.request().postDataJSON();
      const input = JSON.parse(payload.messages[1].content);
      calls.push(input);
      const mapping: Record<string, string> = {
        姓名: '林晓',
        邮箱: 'lin@example.com',
        手机号: '13800138000',
        所在城市: 'sh',
        学历: 'bachelor',
        毕业学校: '示例大学',
        个人优势: data.knowledge[0].content,
        简历附件: 'resume-test',
      };
      const actions = input.page.fields
        .filter((f: { label: string; value: string }) => !f.value && mapping[f.label])
        .map((f: { id: string; label: string }) => ({
          fieldId: f.id,
          value: mapping[f.label],
          source:
            f.label === '个人优势'
              ? 'knowledge'
              : f.label === '学历' || f.label === '毕业学校' || f.label === '简历附件'
                ? 'resume'
                : 'profile',
          ...(f.label === '个人优势' ? { sourceId: 'strengths' } : {}),
          reason: '来自已确认资料',
          confidence: 0.98,
        }));
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          choices: [
            {
              finish_reason: 'stop',
              message: {
                content: JSON.stringify({
                  summary: '先填写基本资料与个人优势，再补充动态教育信息。薪资未知，保留待补充。',
                  actions,
                  missing: input.page.fields
                    .filter((f: { label: string }) => f.label === '期望薪资')
                    .map((f: { id: string }) => ({ fieldId: f.id, question: '请补充期望薪资' })),
                  suggestions: [],
                }),
              },
            },
          ],
        }),
      });
    });
    const application = await context.newPage();
    await application.goto('http://127.0.0.1:5173/tests/fixtures/application.html');
    const tabId = await worker.evaluate(async () => {
      const tabs = await chrome.tabs.query({});
      const applicationTab = tabs.find((t) => t.url?.includes('application.html'));
      if (!applicationTab || applicationTab.id === undefined)
        throw new Error('测试申请标签页不存在');
      return applicationTab.id;
    });
    // Reproduce the missing-metadata case: URL visibility must not be confused
    // with an unsupported protocol when injection itself is authorized.
    await worker.evaluate(() => {
      const originalGet = chrome.tabs.get.bind(chrome.tabs);
      chrome.tabs.get = (async (id: number) => {
        const tab = await originalGet(id);
        const { url, pendingUrl, ...withoutUrl } = tab;
        return withoutUrl;
      }) as typeof chrome.tabs.get;
    });
    const result = await panel.evaluate(async (id) => {
      // An extension tab is used as a side-panel harness. Keep its active-tab
      // query bound to the application that a real side panel would accompany.
      const target = await chrome.tabs.get(id);
      chrome.tabs.query = (async () => [target]) as typeof chrome.tabs.query;
      return { ok: true };
    }, tabId);
    expect(result.ok).toBe(true);
    await panel.getByRole('button', { name: '连接当前页面', exact: true }).click();
    await expect(panel.getByRole('status')).toContainText('页面连接成功');
    await panel.getByRole('button', { name: '启动 Agent', exact: true }).click();
    await expect
      .poll(async () =>
        panel.evaluate(
          async () =>
            (await chrome.storage.session.get('resumePilot.run.v1'))['resumePilot.run.v1']?.status,
        ),
      )
      .toBe('done');
    await expect(application.locator('[name=name]')).toHaveValue('林晓');
    await expect(application.locator('[name=email]')).toHaveValue('lin@example.com');
    await expect(application.locator('[name=city]')).toHaveValue('sh');
    await expect(application.locator('[name=school]')).toHaveValue('示例大学');
    await expect(application.locator('[name=strengths]')).toHaveValue(data.knowledge[0].content);
    expect(
      await application
        .locator('[name=resume]')
        .evaluate((el: HTMLInputElement) => el.files?.[0]?.name),
    ).toBe('林晓-简历.txt');
    await expect(application.locator('[name=salary]')).toHaveValue('');
    await expect(application.locator('[name=captcha]')).toHaveValue('');
    await expect(application.locator('[name=consent]')).not.toBeChecked();
    expect(await application.locator('body').getAttribute('data-submitted')).toBeNull();
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(calls)).not.toContain('integration-test-key');
    const state = await panel.evaluate(
      async () => (await chrome.storage.session.get('resumePilot.run.v1'))['resumePilot.run.v1'],
    );
    expect(state.status).toBe('done');
    expect(state.results.filter((r: { status: string }) => r.status === 'filled')).toHaveLength(8);
    await mkdir('artifacts', { recursive: true });
    await panel.setViewportSize({ width: 1440, height: 1120 });
    await panel.screenshot({ path: 'artifacts/workspace-desktop.png', fullPage: true });
    await panel.setViewportSize({ width: 420, height: 950 });
    await panel.screenshot({ path: 'artifacts/workspace-sidepanel.png', fullPage: true });
    await panel.getByRole('button', { name: '知识库', exact: true }).last().click();
    await panel.getByRole('button', { name: '添加知识', exact: true }).click();
    await panel.getByRole('textbox', { name: '问题 / 标题' }).fill('职业目标');
    await panel.getByRole('textbox', { name: '你的回答' }).fill('希望加入重视工程质量的团队。');
    await panel.getByRole('button', { name: '保存知识', exact: true }).click();
    await expect(panel.getByRole('heading', { name: '职业目标', exact: true })).toBeVisible();
    await panel.getByRole('button', { name: '我的资料', exact: true }).click();
    await panel
      .getByLabel('上传简历', { exact: true })
      .setInputFiles({ name: 'sample.pdf', mimeType: 'application/pdf', buffer: samplePdf() });
    await expect(panel.getByText('sample.pdf', { exact: true })).toBeVisible({ timeout: 15000 });
    await panel.getByRole('button', { name: '编辑 sample.pdf 提取文本', exact: true }).click();
    expect(await panel.locator('.resume-text').inputValue()).toContain('Resume Pilot PDF text');
    await panel.getByRole('button', { name: '取消', exact: true }).click();
    // Review mode must not write until the user executes, and edited values must be honored.
    await panel.evaluate(async () => {
      const key = 'resumePilot.data.v1';
      const value = (await chrome.storage.local.get(key))[key];
      value.settings.autoFill = false;
      value.activeResumeId = 'resume-test';
      await chrome.storage.local.set({ [key]: value });
    });
    await application.reload();
    await panel.evaluate(
      async (id) => chrome.runtime.sendMessage({ type: 'agent.start', tabId: id }),
      tabId,
    );
    await expect(application.locator('[name=name]')).toHaveValue('');
    await panel.getByRole('button', { name: '投递工作台', exact: true }).click();
    await panel.getByRole('textbox', { name: '填写内容：姓名', exact: true }).fill('林小晓');
    await panel.getByRole('button', { name: '执行选中方案', exact: true }).click();
    await expect(application.locator('[name=name]')).toHaveValue('林小晓');
    expect(runtimeErrors).toEqual([]);
  } finally {
    await context.close();
    if (path.resolve(userData).startsWith(path.resolve(tmpdir()) + path.sep + 'resume-pilot-test-'))
      await rm(userData, { recursive: true, force: true });
  }
});

test('preview UI supports knowledge editing and has no overflow at sidepanel width', async ({
  page,
}) => {
  await page.goto('http://127.0.0.1:5173/sidepanel.html');
  await page.setViewportSize({ width: 380, height: 900 });
  await page.getByRole('button', { name: '知识库', exact: true }).last().click();
  await page.getByRole('button', { name: '添加知识', exact: true }).click();
  await page.getByRole('textbox', { name: '问题 / 标题' }).fill('兴趣爱好');
  await page.getByRole('textbox', { name: '你的回答' }).fill('喜欢阅读与摄影。');
  await page.getByRole('button', { name: '保存知识', exact: true }).click();
  await expect(page.getByRole('heading', { name: '兴趣爱好', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: '模型设置', exact: true }).click();
  await page.getByRole('button', { name: /智谱 GLM/ }).click();
  await expect(page.getByLabel('模型名称', { exact: true })).toHaveValue('glm-5.3');
});

test('unmodified extension preserves real access-denied errors and exports injected runtime failures', async () => {
  const userData = await mkdtemp(path.join(tmpdir(), 'resume-pilot-test-'));
  const extensionPath = path.resolve('dist');
  const context = await chromium.launchPersistentContext(userData, {
    channel: 'chromium',
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  try {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker');
    const extensionId = new URL(worker.url()).hostname;
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await panel.setViewportSize({ width: 420, height: 950 });
    const application = await context.newPage();
    await application.goto('http://127.0.0.1:5173/tests/fixtures/application.html');
    const tabId = await worker.evaluate(async () => {
      const tab = (await chrome.tabs.query({})).find((tab) =>
        tab.url?.includes('application.html'),
      );
      if (tab?.id === undefined) throw new Error('测试申请标签页不存在');
      return tab.id;
    });
    const denied = await panel.evaluate(
      async (id) => chrome.runtime.sendMessage({ type: 'page.connect', tabId: id }),
      tabId,
    );
    expect(denied.ok).toBe(false);
    expect(denied.error).toContain('SITE_ACCESS_DENIED');
    const firstLogs = await panel.evaluate(
      async () =>
        (await chrome.storage.local.get('resumePilot.diagnostics.v1.background'))[
          'resumePilot.diagnostics.v1.background'
        ],
    );
    const injectionError = firstLogs.findLast(
      (entry: { stage: string }) => entry.stage === 'script.inject.failed',
    );
    expect(JSON.stringify(injectionError)).toMatch(/Cannot access|permission/i);
    expect(JSON.stringify(injectionError)).toContain('stack');
    await worker.evaluate(() => {
      chrome.scripting.executeScript = (async () => {
        throw new TypeError("Cannot read properties of undefined (reading 'id')");
      }) as typeof chrome.scripting.executeScript;
    });
    const runtimeFailure = await panel.evaluate(
      async (id) => chrome.runtime.sendMessage({ type: 'page.connect', tabId: id }),
      tabId,
    );
    expect(runtimeFailure.error).toContain('CONTENT_SCRIPT_RUNTIME_ERROR');
    expect(runtimeFailure.error).toContain("reading 'id'");
    await expect(panel.locator('.diagnostic-error')).toContainText('reading');
    const downloadEvent = panel.waitForEvent('download');
    await panel.getByRole('button', { name: '导出诊断日志', exact: true }).click();
    const download = await downloadEvent;
    const downloadPath = await download.path();
    expect(downloadPath).toBeTruthy();
    const report = JSON.parse(await readFile(downloadPath!, 'utf8'));
    expect(report.version).toBe('0.1.2');
    expect(JSON.stringify(report.events)).toContain('CONTENT_SCRIPT_RUNTIME_ERROR');
    // Capture the uncaught-promise shape from the screenshot without losing it.
    await panel.evaluate(() => {
      void Promise.reject(
        new TypeError("diagnostic-regression: Cannot read properties of undefined (reading 'id')"),
      );
    });
    await expect
      .poll(async () =>
        panel.evaluate(async () =>
          JSON.stringify(
            (await chrome.storage.local.get('resumePilot.diagnostics.v1.sidepanel'))[
              'resumePilot.diagnostics.v1.sidepanel'
            ],
          ),
        ),
      )
      .toContain('uncaught.promise');
    await mkdir('artifacts', { recursive: true });
    await panel.screenshot({ path: 'artifacts/startup-diagnostics.png', fullPage: true });
  } finally {
    await context.close();
    if (path.resolve(userData).startsWith(path.resolve(tmpdir()) + path.sep + 'resume-pilot-test-'))
      await rm(userData, { recursive: true, force: true });
  }
});
