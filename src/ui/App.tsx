import { useEffect, useRef, useState } from 'react';
import {
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronDown,
  Circle,
  CircleHelp,
  FileText,
  Fingerprint,
  Layers3,
  Loader2,
  MoreHorizontal,
  Plus,
  Radio,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  Sparkles,
  Square,
  Trash2,
  Upload,
  UserRound,
  X,
  Zap,
  Eye,
  EyeOff,
  ExternalLink,
  Pencil,
  RefreshCw,
} from 'lucide-react';
import type {
  Action,
  AppData,
  Knowledge,
  Plan,
  Profile,
  Provider,
  Reply,
  Resume,
  Run,
  Settings,
  Suggestion,
} from '../types';
import {
  defaults,
  emptyData,
  inExtension,
  patchData,
  readData,
  readRun,
  subscribe,
} from '../lib/storage';
import { endpoint } from '../lib/provider';
import { parseResume } from '../lib/resume';
import {
  assertApplicationTab,
  getActiveTab,
  PageConnectionError,
  requestSiteAccess,
  sitePattern,
} from '../lib/browser';
import { version } from '../../package.json';
import {
  captureError,
  DIAGNOSTICS_KEY,
  readDiagnostics,
  recordDiagnostic,
  rememberSecrets,
  type Diagnostic,
} from '../lib/diagnostics';

type Tab = 'workspace' | 'profile' | 'knowledge' | 'settings';
const navigation: { id: Tab; label: string; icon: typeof Zap }[] = [
  { id: 'workspace', label: '投递工作台', icon: Layers3 },
  { id: 'profile', label: '我的资料', icon: UserRound },
  { id: 'knowledge', label: '知识库', icon: BookOpen },
  { id: 'settings', label: '模型设置', icon: Settings2 },
];
const statusLabels: Record<Run['status'], string> = {
  idle: '准备就绪',
  observing: '读取页面',
  planning: '制定计划',
  review: '等待检查',
  executing: '填写中',
  verifying: '验证结果',
  done: '本轮结束',
  stopped: '已停止',
  error: '需要处理',
};
const isBusy = (run?: Run) =>
  !!run && ['observing', 'planning', 'executing', 'verifying'].includes(run.status);
const date = (time: string) =>
  new Date(time).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
const time = (value: string) => new Date(value).toLocaleTimeString('zh-CN', { hour12: false });
async function message<T>(command: object): Promise<T> {
  if (!inExtension())
    throw new Error('当前是界面预览。请将 dist 目录加载为浏览器扩展后，在招聘页面运行 Agent。');
  if (!chrome.runtime?.id)
    throw new PageConnectionError(
      'SIDEPANEL_CONTEXT_INVALIDATED',
      '侧边栏仍连接着已失效的扩展版本，请关闭旧侧边栏并重新打开。诊断日志已保留该错误。',
    );
  const reply: Reply<T> = await chrome.runtime.sendMessage(command);
  if (!reply || typeof reply.ok !== 'boolean')
    throw new Error('插件后台未返回有效结果。请关闭并重新打开侧边栏，必要时重新加载扩展。');
  if (!reply.ok) throw new Error(reply.error);
  return reply.data;
}
function App() {
  const [data, setData] = useState<AppData>(emptyData);
  const [run, setRun] = useState<Run>();
  const [tab, setTab] = useState<Tab>('workspace');
  const [notice, setNotice] = useState<{ text: string; error: boolean }>();
  const [target, setTarget] = useState<{ id?: number; title?: string; url?: string }>({});
  const [launching, setLaunching] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [connection, setConnection] = useState<{
    tabId: number;
    url: string;
    fieldCount: number;
  }>();
  const refresh = async () => {
    try {
      const [storedData, storedRun] = await Promise.all([readData(), readRun()]);
      rememberSecrets(Object.values(storedData.settings.providers).map((config) => config.apiKey));
      setData(storedData);
      setRun(storedRun);
    } catch (error) {
      await captureError('sidepanel', 'storage.refresh.failed', error);
      setNotice({ text: '读取本地资料或任务状态失败，请关闭并重新打开插件侧边栏。', error: true });
    }
  };
  useEffect(() => {
    void refresh();
    return subscribe(() => void refresh());
  }, []);
  useEffect(() => {
    if (!inExtension()) return;
    let disposed = false;
    let revision = 0;
    const update = async () => {
      const request = ++revision;
      try {
        const active = await getActiveTab();
        if (!disposed && revision === request)
          setTarget({ id: active?.id, title: active?.title, url: active?.url });
      } catch (error) {
        void captureError('sidepanel', 'tab.resolve.failed', error);
        if (!disposed && revision === request) setTarget({});
      }
    };
    void update();
    chrome.tabs.onActivated.addListener(update);
    chrome.tabs.onUpdated.addListener(update);
    return () => {
      disposed = true;
      chrome.tabs.onActivated.removeListener(update);
      chrome.tabs.onUpdated.removeListener(update);
    };
  }, []);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(undefined), notice.error ? 12000 : 5000);
    return () => clearTimeout(timer);
  }, [notice]);
  const toast = (text: string, error = false) => setNotice({ text, error });
  const save = async (patch: Partial<AppData>) => {
    try {
      setData(await patchData(patch));
    } catch {
      toast('保存失败，请检查本地存储空间', true);
      throw new Error('保存失败');
    }
  };
  const addSuggestion = async (s: Suggestion) => {
    if (data.knowledge.some((k) => k.title === s.title && k.content === s.content))
      return toast('这条内容已在知识库中');
    await save({
      knowledge: [
        ...data.knowledge,
        { ...s, id: crypto.randomUUID(), updatedAt: new Date().toISOString() },
      ],
    });
    toast('已确认并存入知识库');
  };
  const authorizeCurrent = async () => {
    const expected = target as chrome.tabs.Tab;
    assertApplicationTab(expected);
    const origin = sitePattern(expected);
    // Request directly inside the click's call stack, before any await.
    const permission = requestSiteAccess(expected);
    void recordDiagnostic('sidepanel', 'permission.request', { tabId: expected.id, origin });
    const granted = await permission;
    await recordDiagnostic('sidepanel', 'permission.result', {
      tabId: expected.id,
      origin,
      granted,
    });
    if (!granted)
      throw new PageConnectionError(
        'SITE_PERMISSION_DECLINED',
        '未授予当前站点访问权限，本次任务未启动。可再次点击连接或启动重新授权。',
      );
    const active = await getActiveTab(true);
    assertApplicationTab(active);
    if (active.id !== expected.id || sitePattern(active) !== origin)
      throw new PageConnectionError(
        'TARGET_CHANGED',
        '授权期间切换了标签页或网站，本次任务未启动；请在目标页面重新点击启动。',
      );
    return active;
  };
  const connect = async () => {
    setConnecting(true);
    try {
      const active = await authorizeCurrent();
      const result = await message<{ tabId: number; url: string; fieldCount: number }>({
        type: 'page.connect',
        tabId: active.id,
      });
      setConnection(result);
      toast(`页面连接成功，识别到 ${result.fieldCount} 个可填写字段`);
    } catch (error) {
      setConnection(undefined);
      await captureError('sidepanel', 'connect.failed', error, {
        tabId: target.id,
        url: target.url,
      });
      toast(error instanceof Error ? error.message : String(error), true);
    } finally {
      setConnecting(false);
    }
  };
  const start = async () => {
    if (!inExtension())
      return toast('这是界面预览。请先加载 dist 扩展目录，再在招聘页面启动。', true);
    if (!data.settings.providers[data.settings.provider].apiKey) {
      setTab('settings');
      return toast('先配置 API Key，即可开始填写');
    }
    if (
      !data.resumes.length &&
      !Object.values(data.profile).some(Boolean) &&
      !data.knowledge.length
    ) {
      setTab('profile');
      return toast('上传简历或填写个人资料，让 Agent 认识你');
    }
    setLaunching(true);
    try {
      // Resolve at click time: a panel may remain open through tab switches.
      const active = await authorizeCurrent();
      setTarget({ id: active.id, title: active.title, url: active.url });
      await message({ type: 'agent.start', tabId: active.id });
    } catch (error) {
      await captureError('sidepanel', 'start.failed', error, { tabId: target.id, url: target.url });
      toast((error as Error).message, true);
    } finally {
      setLaunching(false);
      void refresh();
    }
  };
  const busy = isBusy(run) || launching || connecting;
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">
            <Send size={20} />
          </span>
          <span>
            resume<span className="brand-light">pilot</span>
            <small>你的下一站，从这里出发</small>
          </span>
        </div>
        <div className="sidebar-label">PERSONAL WORKSPACE</div>
        <nav>
          {navigation.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              className={tab === id ? 'nav-item active' : 'nav-item'}
              onClick={() => setTab(id)}
            >
              <Icon size={18} />
              <span>{label}</span>
              {id === 'knowledge' && <span className="nav-count">{data.knowledge.length}</span>}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="local-note">
            <ShieldCheck size={18} />
            <div>
              资料保存在本机<small>仅运行时发送至所选模型</small>
            </div>
          </div>
          <div className="account">
            <span className="avatar">{data.profile.name?.slice(0, 1) || '我'}</span>
            <span>
              {data.profile.name || '个人工作空间'}
              <small>Resume Pilot · v{version}</small>
            </span>
            <MoreHorizontal size={18} />
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <span className="breadcrumb">
            我的工作空间 <span>/</span> <b>{navigation.find((n) => n.id === tab)?.label}</b>
          </span>
          <span className="build-badge">
            <span />
            LOCAL FIRST
          </span>
        </header>
        <div className="mobile-brand">
          <Send size={18} /> resume<b>pilot</b>
          <span>投递助手</span>
        </div>
        <nav className="mobile-nav">
          {navigation.map(({ id, label, icon: Icon }) => (
            <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>
              <Icon size={16} />
              {label}
            </button>
          ))}
        </nav>
        <main>
          {!inExtension() && (
            <div className="preview-banner">
              <CircleHelp size={16} /> 界面预览模式 · 加载 dist 扩展目录后可读取招聘页面
            </div>
          )}
          {tab === 'workspace' && (
            <>
              <section className="panel page-connection">
                <div>
                  <strong>目标页面</strong>
                  <p>{target.title || '尚未读取到标签页标题'}</p>
                  <small>
                    {target.url || '没有可用的页面地址，请确认已允许新版扩展的标签页权限。'}
                  </small>
                </div>
                <div>
                  <button
                    className="secondary"
                    disabled={busy || !target.id}
                    onClick={() => void connect()}
                  >
                    {connecting ? <Loader2 size={15} className="spin" /> : <Radio size={15} />}
                    连接当前页面
                  </button>
                  <small>
                    {connection && connection.tabId === target.id && connection.url === target.url
                      ? `已连接 · ${connection.fieldCount} 个字段`
                      : '启动时也会自动请求本站权限'}
                  </small>
                  <a className="text-button" href="#startup-diagnostics">
                    查看诊断日志
                  </a>
                </div>
              </section>
              <Workspace
                data={data}
                run={run}
                target={target}
                busy={busy}
                start={start}
                stop={async () => {
                  try {
                    await message({ type: 'agent.stop', runId: run?.id });
                  } catch (e) {
                    toast((e as Error).message, true);
                  }
                }}
                navigate={setTab}
                toast={toast}
                addSuggestion={addSuggestion}
              />
              <DiagnosticsPanel />
            </>
          )}
          {tab === 'profile' && <ProfilePage data={data} save={save} toast={toast} />}
          {tab === 'knowledge' && <KnowledgePage data={data} save={save} toast={toast} />}
          {tab === 'settings' && (
            <SettingsPage
              settings={data.settings}
              save={async (settings) => {
                await save({ settings });
              }}
              toast={toast}
            />
          )}
        </main>
        <footer>
          <span>少一些重复填写，多一些新的可能。</span>
          <span>
            RESUME PILOT <span className="footer-dot">✳</span>
          </span>
        </footer>
      </div>
      {notice && (
        <div role="status" className={`toast ${notice.error ? 'error' : ''}`}>
          {notice.error ? <CircleHelp size={18} /> : <CheckCircle2 size={18} />}
          <span>{notice.text}</span>
          <button aria-label="关闭通知" onClick={() => setNotice(undefined)}>
            <X size={16} />
          </button>
        </div>
      )}
    </div>
  );
}

function PageTitle({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string;
  title: string;
  description: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {children}
    </div>
  );
}

function Workspace({
  data,
  run,
  target,
  busy,
  start,
  stop,
  navigate,
  toast,
  addSuggestion,
}: {
  data: AppData;
  run?: Run;
  target: { title?: string; url?: string };
  busy: boolean;
  start: () => void;
  stop: () => void;
  navigate: (tab: Tab) => void;
  toast: (s: string, e?: boolean) => void;
  addSuggestion: (s: Suggestion) => Promise<void>;
}) {
  const resume = data.resumes.find((r) => r.id === data.activeResumeId);
  const configured = !!data.settings.providers[data.settings.provider].apiKey;
  const filled = new Set(run?.results.filter((r) => r.status === 'filled').map((r) => r.fieldId))
    .size;
  const total = run?.snapshot?.fields.length || 0;
  const stages = ['读取页面', '匹配资料', '生成计划', '执行与验证'];
  const stage = !run ? -1 : run.status === 'observing' ? 0 : run.status === 'planning' ? 2 : 3;
  let host = '等待选择招聘页面';
  try {
    if (target.url) host = new URL(target.url).hostname || host;
  } catch {
    /* no URL in preview */
  }
  const unresolved =
    run?.plan?.missing.filter((m) =>
      run.snapshot?.fields.some((f) => f.id === m.fieldId && !f.value),
    ) || [];
  return (
    <>
      <PageTitle
        eyebrow="APPLICATION WORKSPACE"
        title={
          data.profile.name ? `${data.profile.name}，向下一站出发。` : '让好机会，少一点距离。'
        }
        description="把重复填写交给 Agent，把注意力留给真正适合你的工作。"
      >
        <span className="subtle-badge">
          <span className={busy ? 'pulse-dot' : 'status-dot'} />
          {run ? statusLabels[run.status] : '准备就绪'}
        </span>
      </PageTitle>
      <section className="hero">
        <div className="hero-copy">
          <div className="hero-tag">
            <Sparkles size={14} /> 你的专属投递 Agent
          </div>
          <h2>
            一份了解，
            <br />
            每一次都恰到好处。
          </h2>
          <p>
            读懂当前申请页面，结合你的经历与优势，
            <br className="wide-only" />
            为这个职位制定专属填写计划。
          </p>
          <div className="hero-actions">
            {busy ? (
              <button className="primary lime" onClick={stop}>
                <Square size={15} />
                停止任务
              </button>
            ) : (
              <button className="primary lime" onClick={start}>
                <Zap size={17} />
                启动 Agent
                <ArrowRight size={17} />
              </button>
            )}
            <span>
              {data.settings.autoFill ? '自动规划 · 填写 · 验证' : '先生成计划，检查后填写'}
            </span>
          </div>
        </div>
        <div className="orbit" aria-hidden="true">
          <div className="orbit-circle outer" />
          <div className="orbit-circle inner" />
          <span className="orbit-star">✳</span>
          <div className="orbit-card card-a">
            <FileText size={16} />
            <span>你的经历</span>
            <Check size={13} />
          </div>
          <div className="orbit-card card-b">
            <Fingerprint size={17} />
            <span>你的独特之处</span>
          </div>
          <span className="orbit-dot" />
        </div>
        <div className="hero-bottom">
          <ShieldCheck size={14} />
          <span>完成后由你检查并提交</span>
          <span className="hero-separator" />
          <span>不编造客观经历</span>
        </div>
      </section>
      <div className="stat-grid">
        <button className="stat-card" onClick={() => navigate('profile')}>
          <span className="stat-icon sage">
            <FileText size={20} />
          </span>
          <div>
            <span className="stat-label">当前简历</span>
            <strong className="file-stat">{resume?.name || '还未上传'}</strong>
            <small>
              {resume ? `${Math.ceil(resume.size / 1024)} KB · 随时切换` : 'PDF / DOCX / TXT / MD'}
            </small>
          </div>
          <ArrowUpRight size={16} />
        </button>
        <button className="stat-card" onClick={() => navigate('knowledge')}>
          <span className="stat-icon sand">
            <BookOpen size={20} />
          </span>
          <div>
            <span className="stat-label">个人知识库</span>
            <strong>
              {data.knowledge.length}
              <em>条记忆</em>
            </strong>
            <small>让每一次表达都有据可依</small>
          </div>
          <ArrowUpRight size={16} />
        </button>
        <button className="stat-card" onClick={() => navigate('settings')}>
          <span className="stat-icon lavender">
            <Sparkles size={20} />
          </span>
          <div>
            <span className="stat-label">驱动模型</span>
            <strong>
              {data.settings.provider === 'deepseek' ? 'DeepSeek' : '智谱 GLM'}
              <span className={`tiny-dot ${configured ? 'green' : ''}`} />
            </strong>
            <small>
              {configured
                ? data.settings.providers[data.settings.provider].model
                : '配置 API Key 后开始'}
            </small>
          </div>
          <ArrowUpRight size={16} />
        </button>
      </div>
      <div className="workspace-grid">
        <section className="panel agent-panel">
          <div className="section-heading">
            <h3>
              <Radio size={17} />
              当前任务
            </h3>
            <span className="small-muted">
              {run ? `第 ${run.round} / ${data.settings.maxRounds} 轮` : '等待启动'}
            </span>
          </div>
          <div className="target-page">
            <span className="site-icon">
              <ExternalLink size={18} />
            </span>
            <div>
              <strong>
                {run?.snapshot?.title || target.title || '在浏览器中打开一份职位申请'}
              </strong>
              <span>{run?.snapshot?.url ? new URL(run.snapshot.url).hostname : host}</span>
            </div>
            <span className="target-label">{run?.snapshot ? '已读取' : '当前页面'}</span>
          </div>
          <div className="stages">
            {stages.map((name, index) => (
              <div className={`stage ${stage >= index ? 'reached' : ''}`} key={name}>
                <span>
                  {stage > index ? (
                    <Check size={12} />
                  ) : busy && stage === index ? (
                    <Loader2 size={12} className="spin" />
                  ) : (
                    index + 1
                  )}
                </span>
                <small>{name}</small>
              </div>
            ))}
          </div>
          {run?.error && (
            <div className="inline-error">
              <CircleHelp size={17} />
              {run.error}
            </div>
          )}
          {run?.snapshot?.warnings.map((w) => (
            <div className="inline-warning" key={w}>
              {w}
            </div>
          ))}
          {run?.plan ? (
            <div className="plan-summary">
              <div className="eyebrow">AGENT PLAN</div>
              <p>{run.plan.summary}</p>
              <div className="progress-row">
                <span>
                  本次成功写入 <b>{filled}</b> 项
                </span>
                <span>识别 {total} 个字段</span>
              </div>
              <div className="progress-track">
                <span style={{ width: `${total ? Math.min(100, (filled / total) * 100) : 0}%` }} />
              </div>
            </div>
          ) : (
            <div className="empty-task">
              <div className="empty-task-icon">
                <Layers3 size={27} />
                <span>
                  <Sparkles size={13} />
                </span>
              </div>
              <h4>{busy ? 'Agent 正在了解这个页面…' : '下一份机会，已经准备好了吗？'}</h4>
              <p>
                {busy
                  ? '填写计划和执行结果会实时显示在这里。'
                  : '打开招聘网站的申请页面，点击「启动 Agent」。'}
                <br />
                {busy ? '你可以随时停止任务。' : '它会先读懂页面，再决定怎么填写。'}
              </p>
            </div>
          )}
          {run?.logs.length ? (
            <details className="logs" open={busy}>
              <summary>
                执行记录{' '}
                <span>
                  {run.logs.length} 条<ChevronDown size={13} />
                </span>
              </summary>
              <ol>
                {run.logs.map((log, i) => (
                  <li key={i}>
                    <time>{time(log.time)}</time>
                    <span>{log.message}</span>
                  </li>
                ))}
              </ol>
            </details>
          ) : null}
        </section>
        <section className="panel readiness">
          <div className="section-heading">
            <h3>出发前的准备</h3>
            <span className="small-muted">
              {[!!resume, !!data.knowledge.length, configured].filter(Boolean).length} / 3
            </span>
          </div>
          {[
            {
              done: !!resume,
              title: '上传一份简历',
              desc: resume
                ? '简历已准备好，Agent 将据此填写。'
                : '你的教育、经历和技能，从这里开始。',
              tab: 'profile' as Tab,
            },
            {
              done: !!data.knowledge.length,
              title: '补充个人知识库',
              desc: '兴趣、优势、职业期待，建立你的表达。',
              tab: 'knowledge' as Tab,
            },
            {
              done: configured,
              title: '连接一个 AI 模型',
              desc: configured ? '模型已配置，可以开始投递。' : '支持 DeepSeek、智谱与兼容接口。',
              tab: 'settings' as Tab,
            },
          ].map((item) => (
            <button className="readiness-item" key={item.title} onClick={() => navigate(item.tab)}>
              {item.done ? <CheckCircle2 size={19} className="text-green" /> : <Circle size={19} />}
              <div>
                <strong>{item.title}</strong>
                <p>{item.desc}</p>
              </div>
              <ArrowRight size={15} />
            </button>
          ))}
          <div className="tip">
            <span>✳</span>
            <p>
              <b>越了解你，越能替你表达。</b>知识库会优先匹配，缺失的客观信息会留给你补充。
            </p>
          </div>
        </section>
      </div>
      {unresolved.length > 0 && (
        <section className="panel missing">
          <div className="section-heading">
            <h3>
              <CircleHelp size={17} />
              需要你补充 <span className="count-badge">{unresolved.length}</span>
            </h3>
            <button className="text-button" onClick={() => navigate('knowledge')}>
              前往知识库
              <ArrowRight size={14} />
            </button>
          </div>
          {unresolved.map((m) => (
            <p key={m.fieldId}>
              <span className="orange-dot" />
              {m.question}
            </p>
          ))}
        </section>
      )}
      {run?.plan && <PlanEditor key={run.id} run={run} busy={busy} toast={toast} />}
      {!!run?.plan?.suggestions.length && (
        <section className="panel">
          <div className="section-heading">
            <h3>
              <BookOpen size={17} />
              值得记住的回答
            </h3>
            <span className="small-muted">确认后加入知识库</span>
          </div>
          {run.plan.suggestions.map((s, i) => (
            <div className="suggestion" key={i}>
              <div>
                <h4>{s.title}</h4>
                <p>{s.content}</p>
              </div>
              <button className="secondary" onClick={() => void addSuggestion(s)}>
                确认入库
                <Plus size={14} />
              </button>
            </div>
          ))}
        </section>
      )}
      <section className="panel history">
        <div className="section-heading">
          <h3>最近填写</h3>
          <span className="small-muted">本机保存最近 50 次记录</span>
        </div>
        {data.history.length ? (
          <div className="history-list">
            {data.history.slice(0, 8).map((h) => (
              <div className="history-row" key={h.id}>
                <span className="history-icon">
                  <FileText size={17} />
                </span>
                <div>
                  <strong>{h.title}</strong>
                  <small>
                    {date(h.time)} · 成功填写 {h.filled} 项
                  </small>
                </div>
                <span className="subtle-badge">{statusLabels[h.status]}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="history-empty">
            <span>还没有填写记录</span>
            <span>
              下一次出发，会被记在这里。
              <ArrowUpRight size={14} />
            </span>
          </div>
        )}
      </section>
    </>
  );
}

function PlanEditor({
  run,
  busy,
  toast,
}: {
  run: Run;
  busy: boolean;
  toast: (s: string, e?: boolean) => void;
}) {
  const planActions = run.proposedActions || run.plan?.actions || [];
  const [actions, setActions] = useState(planActions);
  const [selected, setSelected] = useState(
    new Set(
      planActions
        .filter((a) => !run.snapshot?.fields.find((f) => f.id === a.fieldId)?.value)
        .map((a) => a.fieldId),
    ),
  );
  const actionSignature = JSON.stringify(planActions);
  const valueSignature = JSON.stringify(run.snapshot?.fields.map((f) => [f.id, f.value]));
  useEffect(() => {
    setActions(planActions);
    setSelected(
      new Set(
        planActions
          .filter((a) => !run.snapshot?.fields.find((f) => f.id === a.fieldId)?.value)
          .map((a) => a.fieldId),
      ),
    );
  }, [actionSignature, valueSignature]);
  const execute = async () => {
    try {
      await message({
        type: 'agent.execute',
        runId: run.id,
        actions: actions.filter((a) => selected.has(a.fieldId)),
      });
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  const sourceLabels = {
    profile: '个人资料',
    resume: '简历',
    knowledge: '知识库',
    generated: '基于资料生成',
  };
  return (
    <section className="panel">
      <div className="section-heading">
        <h3>
          <Pencil size={17} />
          填写方案 <span className="count-badge">{actions.length}</span>
        </h3>
        <span className="small-muted">可编辑、取消勾选</span>
      </div>
      {!actions.length ? (
        <p className="small-muted">本轮没有新增填写方案，查看待补充项或执行记录。</p>
      ) : (
        <>
          <div className="action-list">
            {actions.map((a, index) => {
              const field = run.snapshot?.fields.find((f) => f.id === a.fieldId);
              const result = [...run.results].reverse().find((r) => r.fieldId === a.fieldId);
              return (
                <div className="action-item" key={a.fieldId}>
                  <div className="action-title">
                    <label>
                      <input
                        type="checkbox"
                        checked={selected.has(a.fieldId)}
                        onChange={(e) =>
                          setSelected((prev) => {
                            const next = new Set(prev);
                            if (e.target.checked) next.add(a.fieldId);
                            else next.delete(a.fieldId);
                            return next;
                          })
                        }
                      />
                      <strong>{field?.label || a.fieldId}</strong>
                    </label>
                    <span className={`source-chip ${a.source === 'generated' ? 'generated' : ''}`}>
                      {sourceLabels[a.source]}
                    </span>
                  </div>
                  {field?.kind === 'file' ? (
                    <div className="file-value">
                      <FileText size={16} />
                      将上传所选简历附件
                    </div>
                  ) : (
                    <textarea
                      aria-label={`填写内容：${field?.label || a.fieldId}`}
                      rows={Math.min(5, Math.max(2, Math.ceil(a.value.length / 65)))}
                      value={a.value}
                      onChange={(e) =>
                        setActions((prev) =>
                          prev.map((item, i) =>
                            i === index ? { ...item, value: e.target.value } : item,
                          ),
                        )
                      }
                    />
                  )}
                  <p className="action-reason">{a.reason}</p>
                  {result && (
                    <div className={`result-label ${result.status}`}>
                      <CheckCircle2 size={13} />
                      {result.message}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <div className="plan-footer">
            <span className="small-muted">已选 {selected.size} 项 · 已有内容将保留</span>
            <button
              className="primary"
              disabled={busy || !selected.size || !['review', 'done'].includes(run.status)}
              onClick={() => void execute()}
            >
              <Check size={15} />
              执行选中方案
            </button>
          </div>
        </>
      )}
      {run.results.some((r) => r.status !== 'filled') && (
        <details className="result-details">
          <summary>查看未成功填写的字段</summary>
          {run.results
            .filter((r) => r.status !== 'filled')
            .map((r, i) => (
              <p key={i}>
                {run.snapshot?.fields.find((f) => f.id === r.fieldId)?.label || '字段'}：{r.message}
              </p>
            ))}
        </details>
      )}
    </section>
  );
}

function ProfilePage({
  data,
  save,
  toast,
}: {
  data: AppData;
  save: (p: Partial<AppData>) => Promise<void>;
  toast: (s: string, e?: boolean) => void;
}) {
  const [profile, setProfile] = useState(data.profile);
  const [processing, setProcessing] = useState(false);
  const [editing, setEditing] = useState<Resume>();
  const fileRef = useRef<HTMLInputElement>(null);
  const upload = async (file?: File) => {
    if (!file) return;
    setProcessing(true);
    try {
      const resume = await parseResume(file);
      await save({ resumes: [...data.resumes, resume], activeResumeId: resume.id });
      toast('简历已解析并保存在本机');
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setProcessing(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };
  return (
    <>
      <PageTitle
        eyebrow="YOUR PROFILE"
        title="先认识你，再替你表达。"
        description="维护真实的个人资料与简历，Agent 会把它们作为填写依据。"
      />
      <section className="panel">
        <div className="section-heading">
          <h3>
            <UserRound size={17} />
            基本资料
          </h3>
          <span className="small-muted">优先于简历内容</span>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save({ profile }).then(() => toast('个人资料已保存'));
          }}
        >
          <div className="form-grid">
            {(
              [
                { key: 'name', label: '姓名', placeholder: '你的姓名' },
                { key: 'email', label: '邮箱', placeholder: 'you@example.com', type: 'email' },
                { key: 'phone', label: '手机', placeholder: '常用联系电话', type: 'tel' },
                { key: 'city', label: '所在城市', placeholder: '如：上海' },
                { key: 'position', label: '目标职位', placeholder: '如：前端工程师' },
                { key: 'website', label: '个人网站 / 作品集', placeholder: 'https://…' },
              ] as { key: keyof Profile; label: string; placeholder: string; type?: string }[]
            ).map((f) => (
              <label className="form-label" key={f.key}>
                {f.label}
                <input
                  type={f.type || 'text'}
                  value={profile[f.key]}
                  placeholder={f.placeholder}
                  onChange={(e) => setProfile({ ...profile, [f.key]: e.target.value })}
                />
              </label>
            ))}
          </div>
          <div className="form-footer">
            <span className="small-muted">留空的字段会从简历或知识库查找</span>
            <button className="primary" type="submit">
              <Check size={15} />
              保存资料
            </button>
          </div>
        </form>
      </section>
      <section className="panel">
        <div className="section-heading">
          <h3>
            <FileText size={17} />
            我的简历 <span className="count-badge">{data.resumes.length}</span>
          </h3>
          <span className="small-muted">可上传多个版本</span>
        </div>
        <div
          className={`upload-zone ${processing ? 'processing' : ''}`}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            if (!processing) void upload(e.dataTransfer.files[0]);
          }}
        >
          <input
            ref={fileRef}
            type="file"
            accept=".pdf,.docx,.txt,.md"
            aria-label="上传简历"
            hidden
            disabled={processing}
            onChange={(e) => void upload(e.target.files?.[0])}
          />
          {processing ? <Loader2 className="spin" size={28} /> : <Upload size={28} />}
          <h4>{processing ? '正在本地解析简历…' : '将简历拖到这里，或点击上传'}</h4>
          <p>PDF、DOCX、TXT、MD · 最大 8 MB</p>
          <button
            className="secondary"
            disabled={processing}
            onClick={() => fileRef.current?.click()}
          >
            选择简历
            <FileText size={15} />
          </button>
        </div>
        <p className="helper-text">
          文字在本地提取。扫描版 PDF 需先 OCR；页面要求上传附件时，Agent 会使用当前选中的原始文件。
        </p>
        <div className="resume-list">
          {data.resumes.map((r) => (
            <div
              className={`resume-item ${data.activeResumeId === r.id ? 'selected' : ''}`}
              key={r.id}
            >
              <button
                className="resume-select"
                onClick={() => void save({ activeResumeId: r.id })}
                aria-label={`使用简历 ${r.name}`}
              >
                {data.activeResumeId === r.id ? <CheckCircle2 size={19} /> : <Circle size={19} />}
              </button>
              <FileText size={23} />
              <div>
                <strong>{r.name}</strong>
                <small>
                  {Math.ceil(r.size / 1024)} KB · {r.text.length} 字符 · {date(r.updatedAt)}
                </small>
              </div>
              <button
                className="icon-button"
                aria-label={`编辑 ${r.name} 提取文本`}
                title="检查提取文本"
                onClick={() => setEditing(r)}
              >
                <Pencil size={16} />
              </button>
              <button
                className="icon-button danger"
                aria-label={`删除简历 ${r.name}`}
                onClick={() =>
                  void save({
                    resumes: data.resumes.filter((x) => x.id !== r.id),
                    activeResumeId:
                      data.activeResumeId === r.id
                        ? data.resumes.find((x) => x.id !== r.id)?.id || null
                        : data.activeResumeId,
                  })
                }
              >
                <Trash2 size={16} />
              </button>
            </div>
          ))}
        </div>
      </section>
      {editing && (
        <Modal title="检查简历提取文本" close={() => setEditing(undefined)}>
          <p className="helper-text">
            这里的修改用于 Agent 理解简历。上传到招聘网站的原始附件不会改变。
          </p>
          <textarea
            className="resume-text"
            rows={18}
            value={editing.text}
            onChange={(e) => setEditing({ ...editing, text: e.target.value })}
          />
          <div className="modal-footer">
            <button className="secondary" onClick={() => setEditing(undefined)}>
              取消
            </button>
            <button
              className="primary"
              disabled={!editing.text.trim() || editing.text.length > 100000}
              onClick={() =>
                void save({
                  resumes: data.resumes.map((r) =>
                    r.id === editing.id ? { ...editing, updatedAt: new Date().toISOString() } : r,
                  ),
                }).then(() => {
                  setEditing(undefined);
                  toast('简历文本已保存');
                })
              }
            >
              保存文本
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

const categories = [
  '个人优势',
  '兴趣爱好',
  '自我评价',
  '职业规划',
  '项目经历',
  '教育经历',
  '工作经历',
  '其他',
];
function KnowledgePage({
  data,
  save,
  toast,
}: {
  data: AppData;
  save: (p: Partial<AppData>) => Promise<void>;
  toast: (s: string, e?: boolean) => void;
}) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('全部');
  const [editing, setEditing] = useState<Knowledge>();
  const [keywords, setKeywords] = useState('');
  const open = (entry?: Knowledge) => {
    setEditing(
      entry || {
        id: crypto.randomUUID(),
        title: '',
        content: '',
        category: '个人优势',
        keywords: [],
        updatedAt: new Date().toISOString(),
      },
    );
    setKeywords(entry?.keywords.join('，') || '');
  };
  const entries = data.knowledge.filter(
    (k) =>
      (filter === '全部' || k.category === filter) &&
      `${k.title}${k.content}${k.keywords.join(' ')}`.toLowerCase().includes(query.toLowerCase()),
  );
  const exportData = () => {
    const blob = new Blob(
      [JSON.stringify({ version: 1, profile: data.profile, knowledge: data.knowledge }, null, 2)],
      { type: 'application/json' },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'resume-pilot-knowledge.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const importRef = useRef<HTMLInputElement>(null);
  const importData = async (file?: File) => {
    if (!file) return;
    try {
      if (file.size > 2 * 1024 * 1024) throw new Error('知识库文件最大 2 MB');
      const parsed = JSON.parse(await file.text());
      if (parsed.version !== 1 || !Array.isArray(parsed.knowledge) || parsed.knowledge.length > 500)
        throw new Error('文件格式无效，最多支持 500 条知识');
      const incoming: Knowledge[] = parsed.knowledge.map((k: Knowledge) => {
        if (
          typeof k.title !== 'string' ||
          !k.title.trim() ||
          k.title.length > 200 ||
          typeof k.content !== 'string' ||
          !k.content.trim() ||
          k.content.length > 6000
        )
          throw new Error('条目标题或内容格式无效');
        return {
          id: crypto.randomUUID(),
          title: k.title,
          content: k.content,
          category: categories.includes(k.category) ? k.category : '其他',
          keywords: Array.isArray(k.keywords)
            ? k.keywords.filter((v) => typeof v === 'string').slice(0, 20)
            : [],
          updatedAt: new Date().toISOString(),
        };
      });
      const merged = [...data.knowledge];
      for (const entry of incoming)
        if (!merged.some((k) => k.title === entry.title && k.content === entry.content))
          merged.push(entry);
      await save({ knowledge: merged });
      toast(`已合并 ${merged.length - data.knowledge.length} 条知识`);
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      if (importRef.current) importRef.current.value = '';
    }
  };
  return (
    <>
      <PageTitle
        eyebrow="PERSONAL KNOWLEDGE"
        title="你的独特之处，值得被记住。"
        description="把常见问题的真实回答存下来，让每一次填写更贴近你。"
      >
        <button className="primary" onClick={() => open()}>
          <Plus size={16} />
          添加知识
        </button>
      </PageTitle>
      <div className="knowledge-toolbar">
        <label className="search-field">
          <Search size={17} />
          <input
            placeholder="搜索问题、回答或关键词"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <button className="secondary" onClick={exportData}>
          <ArrowDownToLine size={15} />
          导出
        </button>
        <button className="secondary" onClick={() => importRef.current?.click()}>
          <Upload size={15} />
          导入
        </button>
        <input
          hidden
          ref={importRef}
          type="file"
          accept=".json"
          aria-label="导入知识库"
          onChange={(e) => void importData(e.target.files?.[0])}
        />
      </div>
      <div className="filter-tabs">
        {['全部', ...categories].map((c) => (
          <button className={filter === c ? 'active' : ''} key={c} onClick={() => setFilter(c)}>
            {c}
            {c === '全部' && <span>{data.knowledge.length}</span>}
          </button>
        ))}
      </div>
      {entries.length ? (
        <div className="knowledge-grid">
          {entries.map((entry) => (
            <article className="knowledge-card" key={entry.id}>
              <div>
                <span className="category-tag">{entry.category}</span>
                <button
                  className="icon-button"
                  aria-label={`编辑 ${entry.title}`}
                  onClick={() => open(entry)}
                >
                  <Pencil size={15} />
                </button>
              </div>
              <h3>{entry.title}</h3>
              <p>{entry.content}</p>
              <div className="keywords">
                {entry.keywords.map((k, i) => (
                  <span key={i}>#{k}</span>
                ))}
              </div>
              <div className="knowledge-card-footer">
                <small>{date(entry.updatedAt)} 更新</small>
                <button
                  className="icon-button danger"
                  aria-label={`删除知识 ${entry.title}`}
                  onClick={() =>
                    void save({ knowledge: data.knowledge.filter((k) => k.id !== entry.id) })
                  }
                >
                  <Trash2 size={15} />
                </button>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <section className="panel knowledge-empty">
          <BookOpen size={35} />
          <h3>{query || filter !== '全部' ? '没有找到匹配的知识' : '从一个关于你的问题开始'}</h3>
          <p>
            你的优势是什么？喜欢做什么？期待怎样的工作？
            <br />
            这些答案，值得只认真写一次。
          </p>
          <div className="starter-grid">
            {[
              { title: '我的核心优势', category: '个人优势' },
              { title: '我的兴趣爱好', category: '兴趣爱好' },
              { title: '我期待的工作', category: '职业规划' },
            ].map((s) => (
              <button
                className="secondary"
                key={s.title}
                onClick={() => {
                  open();
                  setEditing({
                    id: crypto.randomUUID(),
                    title: s.title,
                    content: '',
                    category: s.category,
                    keywords: [],
                    updatedAt: new Date().toISOString(),
                  });
                }}
              >
                <Plus size={14} />
                {s.title}
              </button>
            ))}
          </div>
        </section>
      )}
      <div className="privacy-note">
        <ShieldCheck size={16} />
        <p>
          知识库仅保存在本机。导出包含基本资料和知识条目；API Key
          与简历附件不会导出。导入只合并知识条目。
        </p>
      </div>
      {editing && (
        <Modal
          title={data.knowledge.some((k) => k.id === editing.id) ? '编辑知识' : '添加一条知识'}
          close={() => setEditing(undefined)}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const entry = {
                ...editing,
                keywords: keywords
                  .split(/[,，、\n]/)
                  .map((k) => k.trim())
                  .filter(Boolean)
                  .slice(0, 20),
                updatedAt: new Date().toISOString(),
              };
              void save({
                knowledge: [...data.knowledge.filter((k) => k.id !== entry.id), entry],
              }).then(() => {
                setEditing(undefined);
                toast('知识已保存');
              });
            }}
          >
            <label className="form-label">
              问题 / 标题
              <input
                required
                maxLength={200}
                placeholder="如：你的核心优势是什么？"
                value={editing.title}
                onChange={(e) => setEditing({ ...editing, title: e.target.value })}
              />
            </label>
            <label className="form-label">
              分类
              <select
                value={editing.category}
                onChange={(e) => setEditing({ ...editing, category: e.target.value })}
              >
                {categories.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </label>
            <label className="form-label">
              你的回答
              <textarea
                required
                maxLength={6000}
                rows={7}
                placeholder="写下真实、具体的回答。可以加入事例或成果。"
                value={editing.content}
                onChange={(e) => setEditing({ ...editing, content: e.target.value })}
              />
            </label>
            <label className="form-label">
              关键词
              <input
                value={keywords}
                onChange={(e) => setKeywords(e.target.value)}
                placeholder="用逗号分隔，如：协作、沟通、前端"
              />
            </label>
            <div className="modal-footer">
              <button className="secondary" type="button" onClick={() => setEditing(undefined)}>
                取消
              </button>
              <button
                className="primary"
                type="submit"
                disabled={!editing.title.trim() || !editing.content.trim()}
              >
                保存知识
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}

function SettingsPage({
  settings,
  save,
  toast,
}: {
  settings: Settings;
  save: (s: Settings) => Promise<void>;
  toast: (s: string, e?: boolean) => void;
}) {
  const [draft, setDraft] = useState(settings);
  const [show, setShow] = useState(false);
  const [testing, setTesting] = useState(false);
  const config = draft.providers[draft.provider];
  const setConfig = (patch: Partial<typeof config>) =>
    setDraft({
      ...draft,
      providers: { ...draft.providers, [draft.provider]: { ...config, ...patch } },
    });
  const permission = async () => {
    const url = new URL(endpoint(config));
    const origin = `${url.origin}/*`;
    if (inExtension() && !(await chrome.permissions.contains({ origins: [origin] }))) {
      if (!(await chrome.permissions.request({ origins: [origin] })))
        throw new Error('未授予这个 API 域名的访问权限');
    }
  };
  const persist = async () => {
    try {
      await permission();
      await save(draft);
      toast('模型与 Agent 设置已保存');
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  const test = async () => {
    setTesting(true);
    try {
      await permission();
      await message({ type: 'provider.test', config });
      toast('模型连接成功');
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setTesting(false);
    }
  };
  return (
    <>
      <PageTitle
        eyebrow="MODEL & PREFERENCES"
        title="给你的 Agent，选一个好搭档。"
        description="使用自己的 API Key，模型服务由你的账户直接调用。"
      />
      <section className="panel">
        <div className="section-heading">
          <h3>
            <Sparkles size={17} />
            模型服务
          </h3>
          <span className="small-muted">OpenAI 兼容格式</span>
        </div>
        <div className="provider-tabs">
          {(['deepseek', 'zhipu'] as Provider[]).map((p) => (
            <button
              className={draft.provider === p ? 'selected' : ''}
              key={p}
              onClick={() => {
                setDraft({ ...draft, provider: p });
                setShow(false);
              }}
            >
              <span className={`provider-logo ${p}`}>{p === 'deepseek' ? 'D' : '智'}</span>
              <span>
                <b>{p === 'deepseek' ? 'DeepSeek' : '智谱 GLM'}</b>
                <small>{p === 'deepseek' ? 'DeepSeek 开放平台' : '智谱开放平台 · 标准 API'}</small>
              </span>
              {draft.provider === p ? <CheckCircle2 size={18} /> : <Circle size={18} />}
            </button>
          ))}
        </div>
        <label className="form-label">
          API Key
          <div className="secret-input">
            <input
              type={show ? 'text' : 'password'}
              autoComplete="off"
              spellCheck={false}
              value={config.apiKey}
              placeholder="输入你的 API Key"
              onChange={(e) => setConfig({ apiKey: e.target.value })}
            />
            <button
              className="icon-button"
              aria-label={show ? '隐藏 API Key' : '显示 API Key'}
              onClick={() => setShow(!show)}
            >
              {show ? <EyeOff size={17} /> : <Eye size={17} />}
            </button>
          </div>
        </label>
        <div className="form-grid">
          <label className="form-label">
            模型名称
            <input
              list={`models-${draft.provider}`}
              value={config.model}
              placeholder="输入平台提供的模型 ID"
              onChange={(e) => setConfig({ model: e.target.value })}
            />
            <datalist id={`models-${draft.provider}`}>
              {(draft.provider === 'deepseek'
                ? ['deepseek-flash', 'deepseek-v4-pro']
                : ['glm-5.3', 'glm-4.7', 'glm-4.5-flash']
              ).map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </label>
          <label className="form-label">
            API Base URL
            <input
              type="url"
              value={config.baseUrl}
              onChange={(e) => setConfig({ baseUrl: e.target.value })}
            />
          </label>
        </div>
        <p className="helper-text">
          自动追加 /chat/completions。可使用支持 JSON
          输出的兼容网关；自定义域名需授予访问权限。智谱编码套餐需改为对应套餐端点。
          <a
            href={
              draft.provider === 'deepseek'
                ? 'https://api-docs.deepseek.com/'
                : 'https://docs.bigmodel.cn/cn/api/introduction'
            }
            target="_blank"
            rel="noreferrer"
          >
            查看官方文档
            <ArrowUpRight size={12} />
          </a>
        </p>
        <div className="form-footer">
          <button
            className="text-button"
            onClick={() => setConfig(defaults.providers[draft.provider])}
          >
            <RefreshCw size={14} />
            重置此服务
          </button>
          <button
            className="secondary"
            disabled={testing || !config.apiKey || !config.model}
            onClick={() => void test()}
          >
            {testing ? <Loader2 className="spin" size={15} /> : <Radio size={15} />}测试连接
          </button>
        </div>
      </section>
      <section className="panel">
        <div className="section-heading">
          <h3>
            <Settings2 size={17} />
            Agent 行为
          </h3>
        </div>
        <Toggle
          checked={draft.autoFill}
          onChange={(autoFill) => setDraft({ ...draft, autoFill })}
          title="生成计划后自动填写"
          description="关闭后，先检查并编辑计划，再执行选中的字段。"
        />
        <Toggle
          checked={draft.allowCreative}
          onChange={(allowCreative) => setDraft({ ...draft, allowCreative })}
          title="允许基于资料组织表达"
          description="用于自我评价、优势、动机等开放回答；客观信息缺失时仍需补充。"
        />
        <label className="round-setting">
          <div>
            <strong>单次最大规划轮数</strong>
            <p>填写后检查动态字段，必要时重新规划；每轮可能产生 API 费用。</p>
          </div>
          <select
            aria-label="最大规划轮数"
            value={draft.maxRounds}
            onChange={(e) => setDraft({ ...draft, maxRounds: Number(e.target.value) })}
          >
            {[1, 2, 3, 4, 5].map((n) => (
              <option value={n} key={n}>
                {n} 轮
              </option>
            ))}
          </select>
        </label>
      </section>
      <div className="privacy-note">
        <ShieldCheck size={19} />
        <p>
          API Key
          存在扩展本地存储中，未加密，网页内容脚本无法读取。运行时会把个人资料、当前简历文本、匹配的知识及页面上下文发送至所选模型服务。最终提交由你完成。
        </p>
      </div>
      <div className="settings-save">
        <button className="primary" onClick={() => void persist()}>
          <Check size={16} />
          保存所有设置
        </button>
      </div>
    </>
  );
}
function DiagnosticsPanel() {
  const [entries, setEntries] = useState<Diagnostic[]>([]);
  const [feedback, setFeedback] = useState('');
  useEffect(() => {
    let disposed = false;
    const update = () => {
      void readDiagnostics()
        .then((items) => {
          if (!disposed) setEntries(items);
        })
        .catch(() => {
          if (!disposed) setFeedback('读取诊断日志失败');
        });
    };
    update();
    if (!inExtension()) {
      window.addEventListener('pilot-diagnostics', update);
      return () => {
        disposed = true;
        window.removeEventListener('pilot-diagnostics', update);
      };
    }
    const listener = (changes: Record<string, chrome.storage.StorageChange>) => {
      if (Object.keys(changes).some((key) => key.startsWith(DIAGNOSTICS_KEY))) update();
    };
    chrome.storage.onChanged.addListener(listener);
    return () => {
      disposed = true;
      chrome.storage.onChanged.removeListener(listener);
    };
  }, []);
  const report = () =>
    JSON.stringify(
      {
        version,
        userAgent: navigator.userAgent,
        extensionId: typeof chrome !== 'undefined' ? chrome.runtime?.id : undefined,
        events: entries,
      },
      null,
      2,
    );
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(report());
      setFeedback('诊断日志已复制');
    } catch {
      setFeedback('无法复制，请点击导出诊断日志');
    }
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([report()], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `resume-pilot-diagnostics-${version}.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const latestError = [...entries].reverse().find((entry) => entry.level === 'error');
  return (
    <section id="startup-diagnostics" className="panel diagnostics-panel">
      <div className="section-heading">
        <h3>
          <CircleHelp size={17} />
          启动诊断 <span className="count-badge">v{version}</span>
        </h3>
        <div className="diagnostic-actions">
          <button className="text-button" onClick={() => void copy()}>
            复制诊断日志
          </button>
          <button className="text-button" onClick={download}>
            导出诊断日志
          </button>
        </div>
      </div>
      <p className="helper-text">
        记录标签页、站点授权、脚本注入、版本握手、模型阶段和原始错误堆栈；不记录简历正文、字段答案或
        API Key。URL 查询参数已移除。
      </p>
      {feedback && (
        <p role="status" className="helper-text">
          {feedback}
        </p>
      )}
      {latestError && (
        <div className="diagnostic-error">
          <b>最近失败阶段：{latestError.stage}</b>
          <pre>{JSON.stringify(latestError.details, null, 2)}</pre>
        </div>
      )}
      <details>
        <summary>查看最近 {entries.length} 条诊断记录</summary>
        <div className="diagnostic-events">
          {[...entries].reverse().map((entry) => (
            <article key={entry.id} className={entry.level}>
              <span>
                {time(entry.time)} · {entry.context} · v{entry.version}
              </span>
              <strong>{entry.stage}</strong>
              <pre>{JSON.stringify(entry.details, null, 2)}</pre>
            </article>
          ))}
        </div>
      </details>
    </section>
  );
}

function Toggle({
  checked,
  onChange,
  title,
  description,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  title: string;
  description: string;
}) {
  return (
    <div className="toggle-row">
      <div>
        <strong>{title}</strong>
        <p>{description}</p>
      </div>
      <button
        role="switch"
        aria-checked={checked}
        aria-label={title}
        className={`toggle ${checked ? 'on' : ''}`}
        onClick={() => onChange(!checked)}
      >
        <span />
      </button>
    </div>
  );
}
function Modal({
  title,
  close,
  children,
}: {
  title: string;
  close: () => void;
  children: React.ReactNode;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return (
    <dialog
      ref={dialogRef}
      className="modal"
      onCancel={close}
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="modal-header">
        <h3>{title}</h3>
        <button className="icon-button" aria-label="关闭弹窗" onClick={close}>
          <X size={18} />
        </button>
      </div>
      <div className="modal-body">{children}</div>
    </dialog>
  );
}
export default App;
