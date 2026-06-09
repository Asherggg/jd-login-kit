#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';

import {
  CookieJar,
  UA,
  buildLoginServiceData,
  buildPythonSolverArgs,
  formEncode,
  isRetryableSlideSolverError,
  loginPageUrl,
  parseHiddenInputs,
  parseJsonp,
  parseSeqSessionId,
  PASSPORT_BASE,
} from '../lib/jd_http_protocol.mjs';

const ROOT = process.cwd();
const OUT = path.join(ROOT, 'outputs');
const PC_TK_URL = 'https://gias.jd.com/js/pc-tk.js';
const SEQ_URL = 'https://seq.jd.com/jseqf.html?bizId=passport_jd_com_login_pc&platform=js&version=1';
const JZT_GETPIN = 'https://jzt-api.jd.com/common/getpin';

function parseArgs(argv) {
  const args = {
    username: process.env.JD_USERNAME || '',
    password: process.env.JD_PASSWORD || '',
    attempts: Number(process.env.JD_ATTEMPTS || 8),
    python: process.env.PYTHON || 'python',
    returnUrl: process.env.JD_RETURN_URL || 'https://jzt.jd.com/home/',
    warmSeq: process.env.JD_WARM_SEQ !== 'false',
    saveCookieValues: process.env.JD_SAVE_COOKIE_VALUES === 'true',
    pcTkPath: '',
    solver: process.env.JD_SLIDE_SOLVER || 'builtin',
    captchaMinConfidence: process.env.JD_CAPTCHA_MIN_CONFIDENCE || '0.8',
    distanceOffsets: process.env.JD_DISTANCE_OFFSETS || '0,-1,1,-2,2,-3,3',
    trajectoryVariants: process.env.JD_TRAJECTORY_VARIANTS || '3',
    ddddocrPresets: process.env.JD_DDDDOCR_PRESETS || '',
    ddddocrCoordinate: process.env.JD_DDDDOCR_COORDINATE || '',
    ddddocrMinConfidence: process.env.JD_DDDDOCR_MIN_CONFIDENCE || '',
    ddddocrDistanceRange: process.env.JD_DDDDOCR_DISTANCE_RANGE || '',
    ddddocrBenchmarkJson: process.env.JD_DDDDOCR_BENCHMARK_JSON || '',
    captchaSkipLowQuality: process.env.JD_CAPTCHA_SKIP_LOW_QUALITY === 'true',
    captchaDistanceRange: process.env.JD_CAPTCHA_DISTANCE_RANGE || '45,135',
    captchaMaxBuiltinDelta: process.env.JD_CAPTCHA_MAX_BUILTIN_DELTA || '12',
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      console.log('Usage: npm run login:http -- --username <user> --password <pass> [--attempts 8] [--python python] [--solver builtin|ddddocr|captcha-recognizer] [--no-warm-seq] [--save-cookie-values]');
      process.exit(0);
    }
    if (a === '--warm-seq') { args.warmSeq = true; continue; }
    if (a === '--no-warm-seq') { args.warmSeq = false; continue; }
    if (a === '--save-cookie-values') { args.saveCookieValues = true; continue; }
    if (a === '--captcha-skip-low-quality') { args.captchaSkipLowQuality = true; continue; }
    if (!a.startsWith('--')) continue;
    const k = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    args[k] = argv[++i];
  }
  args.attempts = Number(args.attempts || 8);
  if (!args.username || !args.password) {
    console.error('Usage: npm run login:http -- --username <user> --password <pass>');
    console.error('Or set JD_USERNAME / JD_PASSWORD.');
    process.exit(2);
  }
  return args;
}

function safeName(s) {
  return String(s).replace(/[^a-zA-Z0-9_.-]+/g, '_');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function redactedObject(obj = {}) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    const s = String(v ?? '');
    out[k] = /pwd|password|token|jwt|eid|fp|uuid|cookie|authcode|validate|pubkey/i.test(k)
      ? `<redacted:${s.length}>`
      : v;
  }
  return out;
}

async function fetchText(url, jar, { method = 'GET', headers = {}, body = undefined, redirect = 'manual' } = {}) {
  const h = {
    'user-agent': UA,
    accept: '*/*',
    ...headers,
  };
  const cookie = jar.header();
  if (cookie) h.cookie = cookie;
  const res = await fetch(url, { method, headers: h, body, redirect });
  jar.mergeResponseHeaders(res.headers);
  return { status: res.status, headers: res.headers, text: await res.text(), url: res.url };
}

async function followRedirects(url, jar, outPrefix, max = 12) {
  const trace = [];
  let current = url;
  for (let i = 0; i < max && current; i++) {
    const res = await fetchText(current, jar, {
      headers: {
        referer: 'https://passport.jd.com/',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      redirect: 'manual',
    }).catch(err => ({ error: String(err), status: 0, text: '' }));
    const location = res.headers?.get?.('location') || '';
    trace.push({ url: current, status: res.status, location, text_start: res.text?.slice?.(0, 300) || '', error: res.error });
    if (!location || ![301, 302, 303, 307, 308].includes(Number(res.status))) break;
    current = new URL(location, current).toString();
  }
  fs.writeFileSync(`${outPrefix}_sso_trace.json`, JSON.stringify(trace, null, 2));
  return trace;
}

async function verifyJztPin(jar, outPrefix) {
  const res = await fetchText(JZT_GETPIN, jar, {
    headers: {
      referer: 'https://jzt.jd.com/',
      accept: 'application/json,text/plain,*/*',
    },
    redirect: 'manual',
  }).catch(err => ({ status: 0, text: '', error: String(err) }));
  const result = { status: res.status, text: res.text?.slice?.(0, 3000) || '', error: res.error || '' };
  try { result.json = JSON.parse(res.text); } catch {}
  result.ok = result.status === 200
    && !/"code"\s*:\s*-?100\b/.test(result.text)
    && !/未登录|not\s*login|login/i.test(result.text);
  fs.writeFileSync(`${outPrefix}_verify_getpin.json`, JSON.stringify(result, null, 2));
  return result;
}

function createElementFactory() {
  function ctx2d() {
    return {
      fillStyle: '', font: '', textBaseline: '', globalCompositeOperation: '',
      beginPath() {}, arc() {}, rect() {}, fill() {}, fillText() {}, stroke() {}, closePath() {},
      createLinearGradient() { return { addColorStop() {} }; },
      isPointInPath() { return false; },
      getImageData(_x, _y, w, h) { return { data: new Uint8ClampedArray(Math.max(4, (w || 10) * (h || 10) * 4)).fill(127) }; },
      measureText(text) { return { width: String(text).length * 8 }; },
    };
  }
  function webgl() {
    return {
      getExtension(name) {
        return name === 'WEBGL_debug_renderer_info'
          ? { UNMASKED_VENDOR_WEBGL: 0x9245, UNMASKED_RENDERER_WEBGL: 0x9246 }
          : null;
      },
      getSupportedExtensions() { return ['ANGLE_instanced_arrays', 'EXT_blend_minmax', 'EXT_color_buffer_half_float', 'WEBGL_debug_renderer_info']; },
      getParameter(p) {
        if (p === 0x9245) return 'Google Inc.';
        if (p === 0x9246) return 'ANGLE (Intel, Intel(R) UHD Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)';
        if (p === 0x0D33) return new Int32Array([16384, 16384]);
        return 8;
      },
      createBuffer() { return {}; }, bindBuffer() {}, bufferData() {},
      createShader() { return {}; }, shaderSource() {}, compileShader() {},
      createProgram() { return {}; }, attachShader() {}, linkProgram() {}, useProgram() {},
      getAttribLocation() { return 0; }, enableVertexAttribArray() {}, vertexAttribPointer() {},
      getUniformLocation() { return {}; }, uniform2f() {}, drawArrays() {},
      clearColor() {}, clear() {}, enable() {}, depthFunc() {},
      getShaderPrecisionFormat() { return { rangeMin: 127, rangeMax: 127, precision: 23 }; },
    };
  }
  return function createElement(name) {
    return {
      nodeName: String(name).toUpperCase(),
      tagName: String(name).toUpperCase(),
      type: '',
      style: {},
      children: [],
      width: 300,
      height: 150,
      appendChild(x) { this.children.push(x); return x; },
      removeChild() {},
      setAttribute(k, v) { this[k] = v; },
      getContext(type) {
        if (type === '2d') return ctx2d();
        if (/webgl/i.test(String(type))) return webgl();
        return null;
      },
      toDataURL() { return 'data:image/png;base64,iVBORw0KGgo='; },
      getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 20 }; },
      offsetWidth: 100,
      offsetHeight: 20,
      innerHTML: '',
      textContent: '',
    };
  };
}

async function runPcTk({ code, jar, pageUrl, timeoutMs = 6000 }) {
  const local = new Map();
  const session = new Map();
  const logs = [];
  const createElement = createElementFactory();

  class XHR {
    open(method, url, async = true) {
      this.method = method;
      this.url = url;
      this.async = async;
      this.readyState = 1;
    }
    setRequestHeader(k, v) {
      (this.headers ||= {})[k] = v;
    }
    async send(body) {
      try {
        const res = await fetch(this.url, {
          method: this.method || 'GET',
          headers: {
            'user-agent': UA,
            'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
            referer: pageUrl,
            origin: 'https://passport.jd.com',
            cookie: jar.header(),
            ...(this.headers || {}),
          },
          body: body || undefined,
        });
        jar.mergeResponseHeaders(res.headers);
        this.status = res.status;
        this.statusText = res.statusText;
        this.responseText = await res.text();
        logs.push({ kind: 'xhr', url: this.url, status: this.status, response_start: this.responseText.slice(0, 300) });
      } catch (err) {
        this.status = 0;
        this.statusText = String(err);
        this.responseText = '';
        logs.push({ kind: 'xhr-error', url: this.url, error: String(err) });
      }
      this.readyState = 4;
      this.onreadystatechange?.();
      this.onload?.();
    }
  }

  const location = {
    protocol: 'https:',
    href: pageUrl,
    host: 'passport.jd.com',
    hostname: 'passport.jd.com',
  };
  const document = {
    location,
    domain: 'jd.com',
    body: createElement('body'),
    documentElement: createElement('html'),
    compatMode: 'CSS1Compat',
    createElement,
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
  };
  Object.defineProperty(document, 'cookie', {
    get() { return jar.header(); },
    set(value) { jar.mergeCookieHeader(String(value).split(';', 1)[0]); },
  });

  const context = {
    console: {
      log: (...args) => logs.push({ kind: 'log', args: args.map(String).slice(0, 4) }),
      debug: (...args) => logs.push({ kind: 'debug', args: args.map(String).slice(0, 4) }),
      error: (...args) => logs.push({ kind: 'error', args: args.map(String).slice(0, 4) }),
      warn: (...args) => logs.push({ kind: 'warn', args: args.map(String).slice(0, 4) }),
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    encodeURIComponent,
    decodeURIComponent,
    unescape,
    bp_bizid: 'jd_pc_login',
    innerWidth: 1280,
    innerHeight: 900,
    outerWidth: 1280,
    outerHeight: 960,
    devicePixelRatio: 1,
    external: {},
    location,
    document,
    navigator: {
      userAgent: UA,
      appName: 'Netscape',
      vendor: 'Google Inc.',
      language: 'zh-CN',
      languages: ['zh-CN', 'zh'],
      platform: 'Win32',
      hardwareConcurrency: 8,
      cookieEnabled: true,
      doNotTrack: null,
      plugins: [{ name: 'Chrome PDF Plugin', description: 'Portable Document Format', filename: 'internal-pdf-viewer', length: 0 }],
      mimeTypes: [],
      javaEnabled: () => false,
    },
    screen: { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040, colorDepth: 24, pixelDepth: 24 },
    localStorage: {
      getItem: k => local.get(k) || null,
      setItem: (k, v) => local.set(k, String(v)),
      removeItem: k => local.delete(k),
    },
    sessionStorage: {
      getItem: k => session.get(k) || null,
      setItem: (k, v) => session.set(k, String(v)),
      removeItem: k => session.delete(k),
    },
    XMLHttpRequest: XHR,
    ActiveXObject: function ActiveXObject() { return new XHR(); },
    Worker: undefined,
    Blob: function Blob() {},
    URL: { createObjectURL: () => '' },
    getComputedStyle: () => ({ getPropertyValue: k => (k === 'font-size' ? '72px' : '') }),
    WebGLRenderingContext: function WebGLRenderingContext() {},
  };
  context.window = context;
  context.self = context;
  context.globalThis = context;
  context.top = context;
  context.parent = context;
  document.defaultView = context;

  vm.createContext(context);
  vm.runInContext(code, context, { timeout: 10000 });

  const start = Date.now();
  while (!context.jdtRiskContext?.isReady?.() && Date.now() - start < timeoutMs) {
    await sleep(100);
  }
  const js = await new Promise(resolve => {
    context.getJsToken?.(result => resolve(result || {}), 1000);
    setTimeout(() => resolve({}), 1500);
  });
  const eidResult = await new Promise(resolve => {
    context.getJdEid?.((eid, fp, extra) => resolve({ eid: eid || '', fp: fp || '', extra: extra || {} }), '', 5);
    setTimeout(() => resolve({ eid: '', fp: '', extra: {} }), 2000);
  });

  if (local.has('3AB9D23F7A4B3CSS')) jar.set('3AB9D23F7A4B3CSS', local.get('3AB9D23F7A4B3CSS'));
  if (local.has('3AB9D23F7A4B3C9B')) jar.set('3AB9D23F7A4B3C9B', local.get('3AB9D23F7A4B3C9B'));
  if (!jar.cookies.has('_gia_d')) jar.set('_gia_d', '1');

  return {
    jsToken: js.jsToken || context.jdtRiskContext?.deviceInfo?.jsToken || '',
    fp: js.fp || eidResult.fp || context.jdtRiskContext?.deviceInfo?.fp || '',
    eid: eidResult.eid || context.jdtRiskContext?.deviceInfo?.eid || '',
    logs,
    localStorage: Object.fromEntries(local.entries()),
  };
}

async function loadPcTk(args, jar, pageUrl) {
  if (args.pcTkPath) return fs.readFileSync(args.pcTkPath, 'utf8');
  const r = await fetchText(PC_TK_URL, jar, { headers: { referer: pageUrl, accept: 'application/javascript,*/*' }, redirect: 'manual' });
  if (r.status !== 200 || !r.text.includes('getJsToken')) throw new Error(`pc-tk.js fetch failed: status=${r.status}`);
  return r.text;
}

async function fetchSeqSessionId(jar, pageUrl) {
  const r = await fetchText(SEQ_URL, jar, { headers: { referer: pageUrl, accept: 'application/javascript,*/*' }, redirect: 'manual' });
  return parseSeqSessionId(r.text);
}

function runSlideSolver({ args, hidden, jar, pageUrl, outPrefix, seqSid }) {
  const solverArgs = buildPythonSolverArgs({
    scriptPath: path.join(ROOT, 'lib', 'jd_iv_protocol.py'),
    hidden: { ...hidden, sessionId: seqSid },
    cookieHeader: jar.header(),
    username: args.username,
    pageUrl,
    outPrefix: `${outPrefix}_slide_debug`,
    warmSeq: args.warmSeq,
    passwordLen: args.password.length,
    solver: args.solver,
    captchaMinConfidence: args.captchaMinConfidence,
    distanceOffsets: args.distanceOffsets,
    trajectoryVariants: args.trajectoryVariants,
    ddddocrPresets: args.ddddocrPresets,
    ddddocrCoordinate: args.ddddocrCoordinate,
    ddddocrMinConfidence: args.ddddocrMinConfidence,
    ddddocrDistanceRange: args.ddddocrDistanceRange,
    ddddocrBenchmarkJson: args.ddddocrBenchmarkJson,
    captchaSkipLowQuality: args.captchaSkipLowQuality,
    captchaDistanceRange: args.captchaDistanceRange,
    captchaMaxBuiltinDelta: args.captchaMaxBuiltinDelta,
  });
  const cp = spawnSync(args.python, solverArgs, { encoding: 'utf8', timeout: 120000, maxBuffer: 20_000_000 });
  fs.writeFileSync(`${outPrefix}_slide_stdout.json`, cp.stdout || '');
  fs.writeFileSync(`${outPrefix}_slide_stderr.txt`, cp.stderr || '');
  if (cp.status !== 0) throw new Error(`python slide solver failed status=${cp.status}: ${cp.stderr.slice(0, 500)}`);
  return JSON.parse(cp.stdout);
}

async function postLoginService({ args, hidden, jar, pageUrl, authcode, seqSid, outPrefix }) {
  const data = buildLoginServiceData({
    hidden,
    username: args.username,
    password: args.password,
    authcode,
    seqSid,
  });
  const url = `${PASSPORT_BASE}/common/loginService?nr=1&r=${Math.random()}&from=jbm_jd&ReturnUrl=${encodeURIComponent(args.returnUrl)}`;
  const res = await fetchText(url, jar, {
    method: 'POST',
    headers: {
      accept: '*/*',
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      origin: PASSPORT_BASE,
      referer: pageUrl,
      'x-requested-with': 'XMLHttpRequest',
    },
    body: formEncode(data),
    redirect: 'manual',
  });
  const result = {
    url,
    status: res.status,
    response_text: res.text,
    response_json: null,
    data_redacted: redactedObject(data),
    cookie_names: jar.names(),
  };
  try { result.response_json = parseJsonp(res.text); } catch {}
  fs.writeFileSync(`${outPrefix}_login_service.json`, JSON.stringify(result, null, 2));
  return result;
}

async function main() {
  const args = parseArgs(process.argv);
  fs.mkdirSync(OUT, { recursive: true });
  const pageUrl = loginPageUrl(args.returnUrl);
  const basePrefix = `${Date.now()}_${safeName(args.username)}_http_protocol`;

  for (let attempt = 1; attempt <= args.attempts; attempt++) {
    const outPrefix = path.join(OUT, `${basePrefix}_attempt${attempt}`);
    const jar = new CookieJar();
    console.log(`[${attempt}/${args.attempts}] fetch login page`);
    const page = await fetchText(pageUrl, jar, {
      headers: { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
      redirect: 'manual',
    });
    if (page.status !== 200) throw new Error(`login page status=${page.status}`);
    const hidden = parseHiddenInputs(page.text);
    const pcTk = await loadPcTk(args, jar, pageUrl);

    console.log(`[${attempt}/${args.attempts}] generate pc-tk tokens without browser engine`);
    const tk = await runPcTk({ code: pcTk, jar, pageUrl });
    hidden.eid = tk.eid;
    hidden.eid2 = tk.jsToken;
    hidden.fp = tk.fp;
    hidden.sessionId = tk.fp;
    hidden.slideAppId ||= '1604ebb2287';
    hidden.pageLocation ||= 'https://jzt.jd.com/';
    const seqSid = await fetchSeqSessionId(jar, pageUrl);

    const stateDiag = {
      pageUrl,
      hidden: redactedObject(hidden),
      token_ok: { eid: !!hidden.eid, eid2: !!hidden.eid2, fp: !!hidden.fp, seqSid: !!seqSid },
      token_lengths: { eid: hidden.eid?.length || 0, eid2: hidden.eid2?.length || 0, fp: hidden.fp?.length || 0, seqSid: seqSid?.length || 0 },
      cookie_names: jar.names(),
      pc_tk_logs: tk.logs,
    };
    if (args.saveCookieValues) stateDiag.cookies = jar.toJSON();
    fs.writeFileSync(`${outPrefix}_state_redacted.json`, JSON.stringify(stateDiag, null, 2));

    if (!hidden.eid || !hidden.eid2 || !hidden.fp || !seqSid) {
      console.log(`[${attempt}/${args.attempts}] missing tokens, retrying`);
      continue;
    }

    console.log(`[${attempt}/${args.attempts}] solve slide by HTTP protocol (${args.solver})`);
    let slide;
    try {
      slide = runSlideSolver({ args, hidden, jar, pageUrl, outPrefix, seqSid });
    } catch (err) {
      if (!isRetryableSlideSolverError(err)) throw err;
      const retryable = {
        success: false,
        retryable: true,
        reason: 'slide_solver_transient_image_decode_error',
        message: String(err?.message || err).slice(0, 1000),
      };
      fs.writeFileSync(`${outPrefix}_slide_error.json`, JSON.stringify(retryable, null, 2));
      console.log(`[${attempt}/${args.attempts}] slide solver transient decode error, retrying next challenge`);
      continue;
    }
    const sr = slide.s_response || {};
    fs.writeFileSync(`${outPrefix}_slide.json`, JSON.stringify(slide, null, 2));
    console.log(`[${attempt}/${args.attempts}] slide distance=${slide.gap?.down_distance} response=${JSON.stringify(sr)}`);
    if (String(sr.success) !== '1' || !sr.validate) continue;

    console.log(`[${attempt}/${args.attempts}] post loginService by HTTP protocol`);
    const login = await postLoginService({ args, hidden, jar, pageUrl, authcode: sr.validate, seqSid, outPrefix });
    const successUrl = login.response_json?.success || '';
    console.log(`[${attempt}/${args.attempts}] loginService status=${login.status} successUrl=${!!successUrl}`);
    if (successUrl) {
      await followRedirects(successUrl, jar, outPrefix);
      const verify = await verifyJztPin(jar, outPrefix);
      const finalState = {
        outputPrefix: outPrefix,
        loginServiceStatus: login.status,
        ssoSuccessUrl: true,
        verify,
        cookie_names: jar.names(),
      };
      if (args.saveCookieValues) finalState.cookies = jar.toJSON();
      fs.writeFileSync(`${outPrefix}_final.json`, JSON.stringify(finalState, null, 2));
      console.log(`OUTPUT_PREFIX=${outPrefix}`);
      console.log(`COOKIE_NAMES=${jar.names().join(',')}`);
      const loginCookieNames = new Set(jar.names());
      const hasLoginCookies = ['thor', 'pin', 'unick', '_pst'].some(name => loginCookieNames.has(name));
      if (successUrl && hasLoginCookies) {
        console.log('LOGIN_OK_HTTP_PROTOCOL');
        return;
      }
      console.log(`[${attempt}/${args.attempts}] loginService success but JZT verification not confirmed, retrying`);
    }
  }
  console.error('LOGIN_NOT_CONFIRMED_HTTP_PROTOCOL');
  process.exit(1);
}

main().catch(err => {
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});
