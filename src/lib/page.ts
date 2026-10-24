import type { Action, ActionResult, Field, Resume, Snapshot } from '../types';

type Control = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLElement;
type Binding = { elements: Control[]; signature: string };
const blocked =
  /password|passwd|captcha|验证码|校验码|银行卡|信用卡|身份证|social.?security|credit.?card|同意|隐私|条款|consent|privacy|terms|subscribe|订阅/i;
const compact = (s: string | null | undefined) => (s || '').replace(/\s+/g, ' ').trim();
export function createPageAgent(document: Document) {
  const documentId = crypto.randomUUID();
  const ids = new WeakMap<Element, string>();
  const bindings = new Map<string, Binding>();
  let sequence = 0;
  let observedUrl = '';
  let cancelled = false;
  function idFor(element: Element) {
    let id = ids.get(element);
    if (!id) {
      id = `${documentId}:${++sequence}`;
      ids.set(element, id);
    }
    return id;
  }
  function visible(element: Element) {
    if (element.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
    const view = element.ownerDocument.defaultView;
    if (!view) return false;
    const style = view.getComputedStyle(element);
    return (
      style.display !== 'none' && style.visibility !== 'hidden' && !!element.getClientRects().length
    );
  }
  function labelFor(element: Control) {
    const doc = element.ownerDocument;
    const root = element.getRootNode() as Document | ShadowRoot;
    const references = (element.getAttribute('aria-labelledby') || '')
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => root.getElementById(id)?.textContent || '')
      .join(' ');
    const textLabel = (label: Element | null | undefined) => {
      if (!label) return '';
      const copy = label.cloneNode(true) as Element;
      copy
        .querySelectorAll(
          'input,select,textarea,button,script,style,[contenteditable],[role="combobox"]',
        )
        .forEach((control) => control.remove());
      return copy.textContent || '';
    };
    const labels =
      'labels' in element
        ? Array.from(element.labels || [])
            .map((l) => textLabel(l))
            .join(' ')
        : '';
    const wrapping = textLabel(element.closest('label'));
    const name = element.getAttribute('name') || element.id;
    // Common design systems place labels and inputs inside a form-item wrapper.
    const wrapper = element.closest(
      '.ant-form-item, .el-form-item, [data-field], .form-field, .form-group',
    );
    const localLabel = textLabel(
      wrapper?.querySelector('label, .ant-form-item-label, .el-form-item__label'),
    );
    return compact(
      element.getAttribute('aria-label') ||
        references ||
        labels ||
        wrapping ||
        localLabel ||
        element.getAttribute('placeholder') ||
        name ||
        '未命名字段',
    ).slice(0, 250);
  }
  function sectionFor(element: Element) {
    return compact(
      element.closest('fieldset')?.querySelector('legend')?.textContent ||
        element.closest('section')?.querySelector('h2,h3,h4')?.textContent,
    ).slice(0, 200);
  }
  function roots(): { root: Document | ShadowRoot; path: string }[] {
    const list: { root: Document | ShadowRoot; path: string }[] = [];
    const add = (root: Document | ShadowRoot, path: string) => {
      list.push({ root, path });
      for (const element of root.querySelectorAll('*')) {
        if (element.shadowRoot && visible(element)) add(element.shadowRoot, path);
        if (element.tagName === 'IFRAME' && visible(element)) {
          try {
            const frame = (element as HTMLIFrameElement).contentDocument;
            if (frame?.body) add(frame, `${path} / 内嵌表单`);
          } catch {
            /* cross-origin frames require separate permission */
          }
        }
      }
    };
    add(document, '');
    return list;
  }
  function currentValue(elements: Control[], kind: Field['kind']) {
    const element = elements[0];
    if (kind === 'radio')
      return (
        (elements.find((e) => (e as HTMLInputElement).checked) as HTMLInputElement | undefined)
          ?.value || ''
      );
    if (kind === 'checkbox') return (element as HTMLInputElement).checked ? 'true' : '';
    if (kind === 'file')
      return Array.from((element as HTMLInputElement).files || [])
        .map((f) => f.name)
        .join(', ');
    if (kind === 'contenteditable') return element.textContent || '';
    return 'value' in element
      ? String(element.value)
      : compact(element.getAttribute('aria-valuetext') || element.textContent);
  }
  function signature(element: Control, kind: Field['kind']) {
    return `${labelFor(element)}|${sectionFor(element)}|${kind}|${element.getAttribute('type')}|${element.getAttribute('name')}`;
  }
  function observe(): Snapshot {
    observedUrl = document.location.href;
    bindings.clear();
    const fields: Field[] = [];
    const warnings: string[] = [];
    for (const { root, path } of roots()) {
      const controls = Array.from(
        root.querySelectorAll<Control>(
          'input, textarea, select, [contenteditable="true"], [role="combobox"]',
        ),
      );
      const grouped = new Set<Control>();
      for (const element of controls) {
        if (
          grouped.has(element) ||
          element.matches(':disabled, [aria-disabled="true"], [readonly]')
        )
          continue;
        if (
          element.closest('[role="combobox"]') !== element &&
          element.closest('[role="combobox"]')
        )
          continue;
        const type = element.getAttribute('type')?.toLowerCase() || 'text';
        if (['hidden', 'password', 'submit', 'reset', 'button', 'image'].includes(type)) continue;
        const label = labelFor(element);
        if (
          blocked.test(
            `${label} ${element.getAttribute('name')} ${element.id} ${element.getAttribute('autocomplete')}`,
          )
        )
          continue;
        if (!visible(element) && type !== 'file') continue;
        if (type === 'file' && element.closest('[hidden], [inert], [aria-hidden="true"]')) continue;
        let kind: Field['kind'] =
          element.tagName === 'SELECT'
            ? 'select'
            : element.tagName === 'TEXTAREA'
              ? 'textarea'
              : element.getAttribute('contenteditable') === 'true'
                ? 'contenteditable'
                : ['radio', 'checkbox', 'file'].includes(type)
                  ? (type as Field['kind'])
                  : element.getAttribute('role') === 'combobox'
                    ? 'combobox'
                    : 'text';
        let elements: Control[] = [element];
        let options: Field['options'] = [];
        if (kind === 'radio') {
          const name = (element as HTMLInputElement).name;
          const form = (element as HTMLInputElement).form;
          elements = name
            ? controls.filter(
                (e) =>
                  e instanceof element.ownerDocument.defaultView!.HTMLInputElement &&
                  e.getAttribute('type') === 'radio' &&
                  (e as HTMLInputElement).name === name &&
                  (e as HTMLInputElement).form === form &&
                  visible(e) &&
                  !e.matches(':disabled'),
              )
            : [element];
          for (const radio of elements) grouped.add(radio);
          options = elements.map((e) => ({
            label: labelFor(e),
            value: (e as HTMLInputElement).value,
          }));
        } else if (kind === 'select') {
          if ((element as HTMLSelectElement).multiple) {
            warnings.push(`「${label}」是多选下拉框，请手动填写。`);
            continue;
          }
          options = Array.from((element as HTMLSelectElement).options)
            .filter(
              (o) =>
                !o.disabled &&
                !(
                  o.parentElement instanceof
                    element.ownerDocument.defaultView!.HTMLOptGroupElement &&
                  o.parentElement.disabled
                ),
            )
            .map((o) => ({ label: compact(o.textContent), value: o.value }));
        } else if (kind === 'combobox') {
          const popup = root.getElementById(
            element.getAttribute('aria-controls') || element.getAttribute('aria-owns') || '',
          );
          options = Array.from(popup?.querySelectorAll('[role="option"]') || []).map((o) => ({
            label: compact(o.textContent),
            value: o.getAttribute('data-value') || compact(o.textContent),
          }));
        }
        const id = idFor(element);
        bindings.set(id, { elements, signature: signature(element, kind) });
        const radioLabel =
          kind === 'radio'
            ? compact(
                element.closest('fieldset')?.querySelector('legend')?.textContent ||
                  element.getAttribute('name'),
              )
            : '';
        fields.push({
          id,
          label: radioLabel || label,
          kind,
          type,
          value: currentValue(elements, kind).slice(0, 16000),
          required: elements.some(
            (e) => e.hasAttribute('required') || e.getAttribute('aria-required') === 'true',
          ),
          options: options.slice(0, 150),
          placeholder: element.getAttribute('placeholder') || '',
          maxLength: Number(element.getAttribute('maxlength') || -1),
          accept: element.getAttribute('accept') || '',
          section: [path, sectionFor(element)].filter(Boolean).join(' / '),
        });
      }
      for (const frame of root.querySelectorAll('iframe')) {
        try {
          if (!frame.contentDocument && visible(frame))
            warnings.push('存在跨域内嵌表单，初版需在新标签页打开该表单后运行。');
        } catch {
          warnings.push('存在无法访问的内嵌表单。');
        }
      }
    }
    if (fields.length > 150) warnings.push('页面字段超过 150 个，仅分析前 150 个；请分区填写。');
    const contextElement =
      document.querySelector<HTMLElement>('main, [role="main"]') || document.body;
    const context = compact(contextElement?.innerText || contextElement?.textContent).slice(
      0,
      12000,
    );
    return {
      documentId,
      url: observedUrl,
      title: document.title,
      context,
      fields: fields.slice(0, 150),
      warnings: [...new Set(warnings)],
      capturedAt: new Date().toISOString(),
    };
  }
  const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  function events(element: Control) {
    const view = element.ownerDocument.defaultView!;
    element.dispatchEvent(new view.Event('input', { bubbles: true, composed: true }));
    element.dispatchEvent(new view.Event('change', { bubbles: true, composed: true }));
    element.dispatchEvent(new view.Event('blur', { bubbles: true }));
  }
  async function fill(action: Action, field: Field, resume?: Resume): Promise<ActionResult> {
    const binding = bindings.get(action.fieldId);
    if (!binding || !binding.elements.every((e) => e.isConnected))
      throw new Error('字段已变化，请重新分析');
    const element = binding.elements[0];
    if (
      signature(element, field.kind) !== binding.signature ||
      element.matches(':disabled, [readonly], [aria-disabled="true"]')
    )
      throw new Error('字段语义或状态已变化，请重新分析');
    if (blocked.test(labelFor(element))) throw new Error('该字段需要手动填写');
    const existing = currentValue(binding.elements, field.kind);
    if (existing)
      return {
        fieldId: field.id,
        status: existing === action.value ? 'filled' : 'skipped',
        message: existing === action.value ? '已是目标值' : '保留页面已有内容',
      };
    if (field.maxLength > 0 && action.value.length > field.maxLength)
      throw new Error(`内容超过 ${field.maxLength} 字符限制，请编辑方案`);
    const view = element.ownerDocument.defaultView!;
    if (field.kind === 'file') {
      if (!resume || resume.id !== action.value) throw new Error('未找到指定简历');
      const accept = (element.getAttribute('accept') || '')
        .toLowerCase()
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean);
      if (
        accept.length &&
        !accept.some(
          (a) =>
            a === resume.mime ||
            (a.startsWith('.') && resume.name.toLowerCase().endsWith(a)) ||
            (a.endsWith('/*') && resume.mime.startsWith(a.slice(0, -1))),
        )
      )
        throw new Error('简历格式与页面要求不符');
      const binary = atob(resume.base64);
      const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
      const transfer = new view.DataTransfer();
      transfer.items.add(new view.File([bytes], resume.name, { type: resume.mime }));
      (element as HTMLInputElement).files = transfer.files;
      events(element);
    } else if (field.kind === 'radio' || field.kind === 'checkbox') {
      const target =
        field.kind === 'radio'
          ? (binding.elements.find(
              (e) => (e as HTMLInputElement).value === action.value || labelFor(e) === action.value,
            ) as HTMLInputElement)
          : (element as HTMLInputElement);
      if (!target || (field.kind === 'checkbox' && !['true', 'false'].includes(action.value)))
        throw new Error('选项值不匹配');
      const desired = field.kind === 'radio' || action.value === 'true';
      if (target.checked !== desired) target.click();
    } else if (field.kind === 'combobox') {
      element.click();
      await delay(160);
      if (cancelled) throw new Error('任务已停止');
      const root = element.getRootNode() as Document | ShadowRoot;
      const popup = root.getElementById(
        element.getAttribute('aria-controls') || element.getAttribute('aria-owns') || '',
      );
      const option = Array.from(popup?.querySelectorAll<HTMLElement>('[role="option"]') || []).find(
        (o) =>
          visible(o) &&
          o.getAttribute('aria-disabled') !== 'true' &&
          [o.getAttribute('data-value'), compact(o.textContent)].includes(action.value),
      );
      if (!option) throw new Error('自定义下拉未暴露可访问选项，请手动选择');
      option.click();
    } else if (field.kind === 'contenteditable') {
      element.textContent = action.value;
      events(element);
    } else {
      const proto =
        field.kind === 'select'
          ? view.HTMLSelectElement.prototype
          : field.kind === 'textarea'
            ? view.HTMLTextAreaElement.prototype
            : view.HTMLInputElement.prototype;
      const value =
        field.kind === 'select'
          ? field.options.find((o) => o.value === action.value || o.label === action.value)?.value
          : action.value;
      if (value === undefined) throw new Error('下拉选项不匹配');
      Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(element, value);
      events(element);
    }
    await delay(120);
    if (!element.isConnected) throw new Error('页面重绘，无法确认字段是否保留，请重新分析');
    const value = currentValue(binding.elements, field.kind);
    const expected =
      field.kind === 'file'
        ? resume!.name
        : field.kind === 'select'
          ? field.options.find((o) => o.value === action.value || o.label === action.value)!.value
          : action.value === 'false' && field.kind === 'checkbox'
            ? ''
            : action.value;
    if (field.kind !== 'combobox' && value !== expected)
      throw new Error('页面未保留写入值，请检查字段格式或组件约束');
    if ('validity' in element && !(element as HTMLInputElement).validity.valid)
      throw new Error((element as HTMLInputElement).validationMessage || '未通过页面格式校验');
    return {
      fieldId: field.id,
      status: 'filled',
      message: field.kind === 'combobox' ? '已选择，建议目视确认' : '已填写并读取验证',
      value,
    };
  }
  return {
    documentId,
    observe,
    stop() {
      cancelled = true;
    },
    async execute(
      expectedDocumentId: string,
      snapshot: Snapshot,
      actions: Action[],
      resume?: Resume,
    ) {
      if (
        documentId !== expectedDocumentId ||
        document.location.href !== observedUrl ||
        snapshot.url !== observedUrl
      )
        throw new Error('页面已导航，请重新分析当前页面');
      cancelled = false;
      const results: ActionResult[] = [];
      for (const action of actions) {
        if (cancelled) break;
        if (document.location.href !== observedUrl) {
          results.push({
            fieldId: action.fieldId,
            status: 'failed',
            message: '页面已导航，停止填写',
          });
          break;
        }
        const field = snapshot.fields.find((f) => f.id === action.fieldId);
        if (!field) continue;
        try {
          results.push(await fill(action, field, resume));
        } catch (error) {
          results.push({
            fieldId: field.id,
            status: 'failed',
            message: error instanceof Error ? error.message : '填写失败',
          });
        }
      }
      return results;
    },
  };
}
