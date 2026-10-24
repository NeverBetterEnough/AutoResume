import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPageAgent } from '../../src/lib/page';
import {
  createPlan,
  buildCompletionBody,
  completion,
  endpoint,
  parsePlan,
  readCompletion,
  validateActions,
} from '../../src/lib/provider';
import { emptyData } from '../../src/lib/storage';
import { retrieveKnowledge } from '../../src/lib/knowledge';
import type { Action, Field, Snapshot } from '../../src/types';

const action = (id: string, value: string, source: Action['source'] = 'profile'): Action => ({
  fieldId: id,
  value,
  source,
  reason: '已确认资料',
  confidence: 0.95,
});
beforeEach(() => {
  document.body.innerHTML = '';
  vi.spyOn(Element.prototype, 'getClientRects').mockReturnValue([
    { width: 200, height: 32 },
  ] as unknown as DOMRectList);
});
describe('DOM observation and execution', () => {
  it('recognizes labels, sections and choices, excludes protected fields', () => {
    document.body.innerHTML = `<fieldset><legend>基本信息</legend><label for="name">姓名</label><input id="name" required><label>密码<input type="password"></label><label>验证码<input name="captcha"></label><label>我同意隐私政策<input type="checkbox"></label><label>城市<select><option value="">请选择</option><option value="sh">上海</option></select></label><label>性别<input type="radio" name="gender" value="f">女</label><label><input type="radio" name="gender" value="m">男</label><button type="submit">提交</button></fieldset>`;
    const snapshot = createPageAgent(document).observe();
    expect(snapshot.fields).toHaveLength(3);
    expect(snapshot.fields[0]).toMatchObject({
      label: '姓名',
      required: true,
      section: '基本信息',
    });
    expect(snapshot.fields[1].options).toContainEqual({ label: '上海', value: 'sh' });
    expect(snapshot.fields[1].label).toBe('城市');
    expect(snapshot.fields[2]).toMatchObject({
      kind: 'radio',
      options: expect.arrayContaining([{ value: 'm', label: '男' }]),
    });
  });
  it('writes native controlled inputs and never clicks submit or replaces existing content', async () => {
    document.body.innerHTML = `<label>姓名<input id="name"></label><label>邮箱<input id="email" value="existing@example.com"></label><button type="submit">提交</button>`;
    const submit = vi.fn();
    document.querySelector('button')!.addEventListener('click', submit);
    const input = vi.fn();
    document.querySelector('#name')!.addEventListener('input', input);
    const agent = createPageAgent(document);
    const snapshot = agent.observe();
    const results = await agent.execute(snapshot.documentId, snapshot, [
      action(snapshot.fields[0].id, '林晓'),
      action(snapshot.fields[1].id, 'other@example.com'),
    ]);
    expect((document.querySelector('#name') as HTMLInputElement).value).toBe('林晓');
    expect((document.querySelector('#email') as HTMLInputElement).value).toBe(
      'existing@example.com',
    );
    expect(input).toHaveBeenCalledOnce();
    expect(submit).not.toHaveBeenCalled();
    expect(results.map((r) => r.status)).toEqual(['filled', 'skipped']);
  });
  it('detects changed field semantics before executing a stale plan', async () => {
    document.body.innerHTML = '<input aria-label="姓名">';
    const agent = createPageAgent(document);
    const snapshot = agent.observe();
    document.querySelector('input')!.setAttribute('aria-label', '银行卡');
    const results = await agent.execute(snapshot.documentId, snapshot, [
      action(snapshot.fields[0].id, '林晓'),
    ]);
    expect(results[0].status).toBe('failed');
    expect((document.querySelector('input') as HTMLInputElement).value).toBe('');
  });
  it('finds new conditional fields on the next observation', async () => {
    document.body.innerHTML =
      '<label>学历<select><option value="">选择</option><option value="bachelor">本科</option></select></label>';
    document.querySelector('select')!.addEventListener('change', () => {
      document.body.insertAdjacentHTML('beforeend', '<label>学校<input required></label>');
    });
    const agent = createPageAgent(document);
    const snapshot = agent.observe();
    await agent.execute(snapshot.documentId, snapshot, [action(snapshot.fields[0].id, 'bachelor')]);
    expect(agent.observe().fields.map((f) => f.label)).toContain('学校');
  });
  it('reads open shadow-root form controls', () => {
    const host = document.createElement('div');
    document.body.append(host);
    host.attachShadow({ mode: 'open' }).innerHTML = '<label>作品集<input></label>';
    expect(createPageAgent(document).observe().fields[0].label).toBe('作品集');
  });
  it('respects max length and rejects a foreign document plan', async () => {
    document.body.innerHTML = '<label>姓名<input maxlength="2"></label>';
    const agent = createPageAgent(document);
    const snapshot = agent.observe();
    const result = await agent.execute(snapshot.documentId, snapshot, [
      action(snapshot.fields[0].id, '名字太长'),
    ]);
    expect(result[0].message).toContain('字符限制');
    await expect(agent.execute('other', snapshot, [])).rejects.toThrow('页面已导航');
  });
});

describe('planning and providers', () => {
  const field: Field = {
    id: 'name',
    label: '姓名',
    kind: 'text',
    type: 'text',
    value: '',
    required: true,
    options: [],
    placeholder: '',
    maxLength: -1,
    accept: '',
    section: '',
  };
  const snapshot: Snapshot = {
    documentId: 'doc',
    url: 'https://example.com/apply',
    title: '申请',
    context: '前端工程师 React TypeScript',
    fields: [field],
    warnings: [],
    capturedAt: '',
  };
  it('rejects hallucinated targets, duplicates, weak confidence and generated objective fields', () => {
    const data = emptyData();
    const actions = [
      action('missing', 'x'),
      action('name', '编造的名字', 'generated'),
      { ...action('name', 'a'), confidence: 0.2 },
      action('name', '林晓'),
      action('name', '李明'),
    ];
    expect(validateActions(actions, snapshot, data)).toEqual([action('name', '林晓')]);
  });
  it('requires actual knowledge source ids and allows grounded prose only when enabled', () => {
    const data = emptyData();
    const textarea = { ...snapshot, fields: [{ ...field, kind: 'textarea' as const }] };
    expect(validateActions([action('name', 'x', 'knowledge')], textarea, data)).toEqual([]);
    expect(validateActions([action('name', 'x', 'generated')], textarea, data)).toHaveLength(1);
    data.settings.allowCreative = false;
    expect(validateActions([action('name', 'x', 'generated')], textarea, data)).toEqual([]);
  });
  it('parses fenced JSON and rejects invalid structured output', () => {
    expect(parsePlan('```json\n{"summary":"匹配职位","actions":[]}\n```').missing).toEqual([]);
    expect(() => parsePlan('{"actions":"click submit"}')).toThrow('格式无效');
  });
  it('builds official endpoints and rejects credential-bearing or insecure URLs', () => {
    const config = emptyData().settings.providers;
    expect(endpoint(config.deepseek)).toBe('https://api.deepseek.com/chat/completions');
    expect(endpoint(config.zhipu)).toBe('https://open.bigmodel.cn/api/paas/v4/chat/completions');
    expect(() =>
      endpoint({ ...config.deepseek, baseUrl: 'https://key:secret@example.com' }),
    ).toThrow();
    expect(() => endpoint({ ...config.deepseek, baseUrl: 'http://example.com' })).toThrow();
    expect(endpoint({ ...config.deepseek, baseUrl: 'http://localhost:4318/v1' })).toBe(
      'http://localhost:4318/v1/chat/completions',
    );
  });
  it('retrieves relevant Chinese and English knowledge before unrelated entries', () => {
    const entries = ['兴趣爱好', 'React 前端技术优势', '期望薪资'].map((title, i) => ({
      id: String(i),
      title,
      content: title,
      category: '其他',
      keywords: [],
      updatedAt: '',
    }));
    expect(retrieveKnowledge(entries, snapshot, 1)[0].id).toBe('1');
  });
  it('sends the key only in Authorization, not in model context, and marks rejected required fields missing', async () => {
    const data = emptyData();
    data.settings.providers.deepseek.apiKey = 'secret-test-key';
    data.profile.name = '林晓';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  summary: '填写',
                  actions: [action('name', '捏造', 'generated')],
                }),
              },
            },
          ],
        }),
        { headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const plan = await createPlan(data, snapshot, new AbortController().signal);
    const request = fetchMock.mock.calls[0][1]!;
    expect((request.headers as Record<string, string>).Authorization).toBe(
      'Bearer secret-test-key',
    );
    expect(request.body).not.toContain('secret-test-key');
    expect(plan.actions).toHaveLength(0);
    expect(plan.missing[0].fieldId).toBe('name');
  });
  it('does not echo API errors containing credentials', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('secret-key-returned-by-proxy', { status: 401 }),
    );
    await expect(
      completion({ ...emptyData().settings.providers.deepseek, apiKey: 'secret' }, []),
    ).rejects.toThrow('API Key 无效');
  });
  it('enables thinking with low effort for GLM-5.3 in both test and planning requests', async () => {
    const config = { ...emptyData().settings.providers.zhipu, apiKey: 'zhipu-test-key' };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init!.body));
      // Emulate the actual GLM-5.3 parameter constraint rather than accepting any body.
      if (body.thinking?.type !== 'enabled' || body.reasoning_effort !== 'low') {
        return new Response(
          JSON.stringify({
            error: { code: '1210', message: 'GLM-5.3 does not support disabled thinking' },
          }),
          { status: 400 },
        );
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), {
        headers: { 'Content-Type': 'application/json' },
      });
    });
    await expect(
      completion(config, [{ role: 'user', content: 'Reply with OK.' }], undefined, false),
    ).resolves.toBe('OK');
    const testBody = JSON.parse(String(fetchMock.mock.calls[0][1]!.body));
    expect(testBody).toMatchObject({
      model: 'glm-5.3',
      thinking: { type: 'enabled' },
      reasoning_effort: 'low',
    });
    expect(testBody).not.toHaveProperty('response_format');
    const planBody = buildCompletionBody(config, [{ role: 'user', content: 'Return JSON.' }]);
    expect(planBody).toMatchObject({
      thinking: { type: 'enabled' },
      reasoning_effort: 'low',
      response_format: { type: 'json_object' },
    });
  });
  it('keeps non-thinking mode for supported models and omits vendor options for unknown models', () => {
    const base = emptyData().settings.providers.deepseek;
    for (const model of [
      'deepseek-flash',
      'deepseek-v4-pro',
      'glm-4.7',
      'glm-4.5-flash',
      'glm-5.2',
    ]) {
      expect(buildCompletionBody({ ...base, model }, [])).toMatchObject({
        thinking: { type: 'disabled' },
      });
    }
    for (const model of ['some-compatible-model', 'glm-4-flash']) {
      expect(buildCompletionBody({ ...base, model }, [])).not.toHaveProperty('thinking');
    }
  });
  it('shows provider error code and parameter detail without exposing keys', async () => {
    const key = 'private-key.for-error-test';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: '1210',
            message: `thinking.type disabled is not supported; key=${key}; Authorization: Bearer another-token; sk-sensitive123456`,
          },
        }),
        { status: 400 },
      ),
    );
    const error = await completion(
      { ...emptyData().settings.providers.zhipu, apiKey: key },
      [],
    ).catch((e) => e as Error);
    expect(error).toBeInstanceOf(Error);
    const text = (error as Error).message;
    expect(text).toContain('1210');
    expect(text).toContain('thinking.type disabled is not supported');
    expect(text).not.toContain(key);
    expect(text).not.toContain('another-token');
    expect(text).not.toContain('sk-sensitive123456');
  });
  it('ignores non-JSON gateway error bodies instead of echoing them', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('<html>private gateway diagnostics</html>', { status: 400 }),
    );
    const error = await completion(
      { ...emptyData().settings.providers.zhipu, apiKey: 'test' },
      [],
    ).catch((e) => e as Error);
    expect((error as Error).message).toContain('HTTP 400');
    expect((error as Error).message).not.toContain('private gateway diagnostics');
  });
  it('reassembles streaming JSON across split UTF-8 chunks', async () => {
    const bytes = new TextEncoder().encode(
      'data: {"choices":[{"delta":{"content":"你好"}}]}\n\ndata: {"choices":[{"delta":{"content":"，世界"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    );
    const response = new Response(
      new ReadableStream({
        start(controller) {
          for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
          controller.close();
        },
      }),
      { headers: { 'Content-Type': 'text/event-stream' } },
    );
    expect(await readCompletion(response)).toBe('你好，世界');
  });
  it('rejects interrupted model streams', async () => {
    const response = new Response('data: {"choices":[{"delta":{"content":"incomplete"}}]}\n\n', {
      headers: { 'Content-Type': 'text/event-stream' },
    });
    await expect(readCompletion(response)).rejects.toThrow('意外中断');
  });
});
