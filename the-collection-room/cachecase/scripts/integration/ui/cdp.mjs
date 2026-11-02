// Minimal Chrome DevTools Protocol driver (Node built-ins only: fetch,
// WebSocket, child_process) for driving the CacheCase web build. Each
// collector gets an isolated browser context — separate storage/session,
// like separate phones.
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export async function launchChrome({ port = 9333, profileDir }) {
  mkdirSync(profileDir, { recursive: true });
  const proc = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--window-size=390,844',
    ],
    { stdio: 'ignore' },
  );
  let wsUrl;
  for (let i = 0; i < 100 && !wsUrl; i++) {
    try {
      wsUrl = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl;
    } catch {
      await sleep(100);
    }
  }
  if (!wsUrl) throw new Error('Chrome did not start');
  const browser = new Browser(wsUrl, proc);
  await browser.ready;
  return browser;
}

class Browser {
  constructor(wsUrl, proc) {
    this.proc = proc;
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map(); // sessionId -> fn(method, params)
    this.ready = new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
    });
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} ${msg.error.data ?? ''}`));
        else resolve(msg.result);
      } else if (msg.method) {
        this.listeners.get(msg.sessionId)?.(msg.method, msg.params);
      }
    };
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  async newPage(label, { width = 390, height = 844 } = {}) {
    const { browserContextId } = await this.send('Target.createBrowserContext', { disposeOnDetach: true });
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank', browserContextId });
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    const page = new Page(this, sessionId, label);
    this.listeners.set(sessionId, (m, p) => page.onEvent(m, p));
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: false });
    return page;
  }

  async close() {
    try {
      await this.send('Browser.close');
    } catch {}
    this.proc.kill();
  }
}

class Page {
  constructor(browser, sessionId, label) {
    this.browser = browser;
    this.sessionId = sessionId;
    this.label = label;
    this.errors = [];
    this.logs = [];
    this.fileChooser = null;
  }

  send(method, params) {
    return this.browser.send(method, params, this.sessionId);
  }

  onEvent(method, params) {
    if (method === 'Runtime.exceptionThrown') {
      this.errors.push(params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text);
    } else if (method === 'Runtime.consoleAPICalled') {
      const text = params.args.map((a) => a.value ?? a.description ?? '').join(' ');
      this.logs.push(`${params.type}: ${text}`);
      if (params.type === 'error') this.errors.push(text);
    } else if (method === 'Page.fileChooserOpened') {
      this.fileChooser?.(params);
    } else if (method === 'Fetch.requestPaused') {
      this.requestUrls.push(`${params.request.method} ${params.request.url}`);
      const rule = this.fakeResponses?.find((r) => r.match.test(params.request.url));
      if (rule && params.request.method === 'OPTIONS') {
        // CORS preflight for a faked request: allow it.
        void this.send('Fetch.fulfillRequest', {
          requestId: params.requestId,
          responseCode: 204,
          responseHeaders: [
            { name: 'access-control-allow-origin', value: '*' },
            { name: 'access-control-allow-headers', value: '*' },
            { name: 'access-control-allow-methods', value: 'GET,POST,PATCH,DELETE,OPTIONS' },
          ],
        });
      } else if (rule) {
        this.fakedUrls.push(params.request.url);
        void this.send('Fetch.fulfillRequest', {
          requestId: params.requestId,
          responseCode: rule.status,
          responseHeaders: [
            { name: 'content-type', value: 'application/json' },
            { name: 'access-control-allow-origin', value: '*' },
          ],
          body: Buffer.from(JSON.stringify(rule.body)).toString('base64'),
        });
      } else {
        void this.send('Fetch.continueRequest', { requestId: params.requestId });
      }
    }
  }

  // Answers matching requests with a canned response (e.g. a database
  // without some table) instead of sending them. Call before goto().
  async fakeRequests(rules) {
    this.fakeResponses = rules;
    this.fakedUrls = [];
    this.requestUrls = [];
    await this.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
  }

  async goto(url) {
    await this.send('Page.navigate', { url });
    await this.waitFor('document.readyState === "complete"', 30000);
  }

  async eval(expression) {
    const res = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (res.exceptionDetails) throw new Error(`eval failed: ${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}`);
    return res.result.value;
  }

  async waitFor(expression, timeout = 15000, what = expression) {
    const end = Date.now() + timeout;
    let last;
    while (Date.now() < end) {
      try {
        last = await this.eval(expression);
        if (last) return last;
      } catch {}
      await sleep(150);
    }
    throw new Error(`[${this.label}] timed out waiting for: ${what}`);
  }

  // In-page element finder. kind: 'label' (aria-label exact), 'labelStarts',
  // 'text' (innermost visible element whose text is exact), 'placeholder'.
  static finder(kind, value) {
    return `(() => {
      const v = ${JSON.stringify(value)};
      const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && r.bottom > 0 && r.top < innerHeight; };
      let els = [];
      if (${JSON.stringify(kind)} === 'label') els = [...document.querySelectorAll('[aria-label]')].filter(e => e.getAttribute('aria-label') === v);
      else if (${JSON.stringify(kind)} === 'labelStarts') els = [...document.querySelectorAll('[aria-label]')].filter(e => e.getAttribute('aria-label').startsWith(v));
      else if (${JSON.stringify(kind)} === 'placeholder') els = [...document.querySelectorAll('input,textarea')].filter(e => e.placeholder === v);
      else if (${JSON.stringify(kind)} === 'testid') els = [...document.querySelectorAll('[data-testid]')].filter(e => e.dataset.testid === v);
      else els = [...document.querySelectorAll('div,span,a,button')].filter(e => e.textContent.trim() === v && ![...e.children].some(c => c.textContent.trim() === v));
      return els.filter(visible).pop() ?? null;
    })()`;
  }

  async exists(kind, value) {
    return this.eval(`!!${Page.finder(kind, value)}`);
  }

  async waitForEl(kind, value, timeout = 15000) {
    return this.waitFor(`!!${Page.finder(kind, value)}`, timeout, `${kind}=${value}`);
  }

  // A real mouse press at the element's centre (RN-web Pressables respond to
  // pointer events, not synthetic .click()).
  async tap(kind, value, timeout = 15000) {
    await this.waitForEl(kind, value, timeout);
    const { x, y } = await this.eval(`(() => { const r = ${Page.finder(kind, value)}.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await this.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, pointerType: 'mouse' });
    }
    await sleep(250);
  }

  // Press and hold (RN-web Pressable onLongPress).
  async longPress(kind, value, holdMs = 900) {
    await this.waitForEl(kind, value);
    const { x, y } = await this.eval(`(() => { const r = ${Page.finder(kind, value)}.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await sleep(holdMs);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    await sleep(300);
  }

  async type(kind, value, text) {
    await this.tap(kind, value);
    await this.eval(`(${Page.finder(kind, value)}).focus()`);
    await this.send('Input.insertText', { text });
    await sleep(200);
  }

  async text() {
    return this.eval('document.body.innerText');
  }

  async screenshot(path) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(path, Buffer.from(data, 'base64'));
  }
}
