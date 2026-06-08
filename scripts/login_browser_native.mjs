#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'outputs');
const TARGET = 'https://jzt.jd.com/gw/index?ReturnUrl=https%3A%2F%2Fjzt.jd.com%2Fhome%2F';

function parseArgs(argv) {
  const args = { username: process.env.JD_USERNAME || '', password: process.env.JD_PASSWORD || '', headless: process.env.JD_HEADLESS === 'true', attempts: 3, python: process.env.PYTHON || 'python3', keepOpen: true };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      console.log('Usage: npm run login -- --username <user> --password <pass> [--attempts 3] [--headless] [--no-keep-open]');
      process.exit(0);
    }
    if (a === '--headless') { args.headless = true; continue; }
    if (a === '--no-keep-open') { args.keepOpen = false; continue; }
    if (!a.startsWith('--')) continue;
    const k = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    args[k] = argv[++i];
  }
  if (!args.username || !args.password) {
    console.error('Usage: npm run login -- --username <user> --password <pass> [--headless]');
    process.exit(2);
  }
  args.attempts = Number(args.attempts || 3);
  return args;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function safeName(s) { return String(s).replace(/[^a-zA-Z0-9_.-]+/g, '_'); }

async function getPassportFrame(page) {
  for (let i = 0; i < 100; i++) {
    const frame = page.frames().find(f => /passport\.jd\.com\/common\/loginPage/.test(f.url()));
    if (frame) return frame;
    await sleep(100);
  }
  throw new Error('passport.jd.com login iframe not found');
}

async function waitLoginVisible(page, username, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const txt = await page.locator('body').innerText({ timeout: 1000 }).catch(() => '');
    if (txt.includes(username) && /退出登录|立即投放|账户|推广|广告/.test(txt)) return { ok: true, text: txt.slice(0, 1000), url: page.url() };
    await sleep(500);
  }
  return { ok: false, text: (await page.locator('body').innerText({ timeout: 1000 }).catch(() => '')).slice(0, 1000), url: page.url() };
}

async function dumpFreshState(frame, username, password, outPath) {
  const dumperSource = fs.readFileSync(path.join(ROOT, 'lib', 'dump_fresh_with_seq.js'), 'utf8');
  await frame.evaluate(dumperSource);
  const state = await frame.evaluate(async ({ username, password }) => {
    return await window.jdIvFreshLoginAndDump({ username, password, triggerLogin: true, refreshCaptcha: false, timeoutMs: 12000, tokenTimeoutMs: 3000 });
  }, { username, password });
  fs.writeFileSync(outPath, JSON.stringify(state, null, 2));
  return state;
}

function buildMouse(statePath, outPrefix, python) {
  const outJson = `${outPrefix}_mouse.json`;
  const py = spawnSync(python, [path.join(ROOT, 'lib', 'jd_iv_protocol.py'), '--live-json', statePath, '--out', `${outPrefix}_debug`, '--dry-run', '--rewrite-seq-time'], { encoding: 'utf8' });
  if (py.status !== 0) throw new Error(`python solver failed\nSTDOUT:\n${py.stdout}\nSTDERR:\n${py.stderr}`);
  fs.writeFileSync(outJson, py.stdout);
  return JSON.parse(py.stdout);
}

async function browserSubmit(frame, points) {
  return await frame.evaluate(async (points) => {
    window.__jdNativeLogin = { start: Date.now(), events: [] };
    const oldAjax = window.$ && $.ajax;
    if (oldAjax && !$.ajax.__jdNativeWrapped) {
      const wrapped = function(opts) {
        if (opts && String(opts.url || '').includes('/common/loginService')) {
          window.__jdNativeLogin.events.push({ kind: 'loginService-call', url: String(opts.url), dataKeys: Object.keys(opts.data || {}), authcode: opts.data?.authcode, loginname: opts.data?.loginname });
          const os = opts.success, oe = opts.error;
          opts.success = function(result) {
            window.__jdNativeLogin.events.push({ kind: 'loginService-success', raw: String(result).slice(0, 3000) });
            try { return os && os.apply(this, arguments); } catch (e) { window.__jdNativeLogin.events.push({ kind: 'loginService-handler-error', error: String(e) }); }
          };
          opts.error = function() {
            window.__jdNativeLogin.events.push({ kind: 'loginService-error', args: Array.from(arguments).map(x => String(x)).slice(0, 5) });
            try { return oe && oe.apply(this, arguments); } catch (e) { window.__jdNativeLogin.events.push({ kind: 'loginService-error-handler-error', error: String(e) }); }
          };
        }
        return oldAjax.apply(this, arguments);
      };
      wrapped.__jdNativeWrapped = true;
      $.ajax = wrapped;
    }

    const a = window.jdSlide;
    if (!a) throw new Error('window.jdSlide missing');
    const oldCb = a.callback;
    a.callback = function(c) {
      const rec = { kind: 'slide-callback' };
      try {
        rec.success = c && c.getSuccess && c.getSuccess();
        rec.message = c && c.getMessage && c.getMessage();
        rec.validate = c && c.getValidate && c.getValidate();
      } catch (e) { rec.error = String(e); }
      window.__jdNativeLogin.events.push(rec);
      return oldCb && oldCb.apply(this, arguments);
    };
    a.mousePos = points;
    a.submit();
    await new Promise(r => setTimeout(r, 9000));
    return {
      href: location.href,
      events: window.__jdNativeLogin.events,
      dataCode: document.querySelector('#paipaiLoginSubmit')?.getAttribute('data-code') || '',
      cookieNames: document.cookie.split(';').map(s => s.trim().split('=')[0]).filter(Boolean),
      text: document.body.innerText.slice(0, 1000),
    };
  }, points);
}

async function main() {
  const args = parseArgs(process.argv);
  fs.mkdirSync(OUT, { recursive: true });
  const profile = path.join(ROOT, 'browser-profile');
  const context = await chromium.launchPersistentContext(profile, { headless: args.headless, viewport: { width: 1280, height: 900 } });
  const page = context.pages()[0] || await context.newPage();
  page.setDefaultTimeout(20000);

  let last = null;
  for (let attempt = 1; attempt <= args.attempts; attempt++) {
    console.log(`[${attempt}/${args.attempts}] open login page`);
    await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const frame = await getPassportFrame(page);
    const base = path.join(OUT, `${Date.now()}_${safeName(args.username)}_attempt${attempt}`);
    const statePath = `${base}_state.json`;
    console.log(`[${attempt}/${args.attempts}] dump fresh captcha state`);
    const state = await dumpFreshState(frame, args.username, args.password, statePath);
    if (!state.challenge || !state.imgs || state.imgs.length < 2) throw new Error(`bad state: challenge=${state.challenge}, imgs=${state.imgs?.length}`);
    console.log(`[${attempt}/${args.attempts}] challenge=${state.challenge}`);
    const mouse = buildMouse(statePath, base, args.python);
    console.log(`[${attempt}/${args.attempts}] distance=${mouse.gap?.down_distance}, points=${mouse.mousePos?.length}`);
    const submit = await browserSubmit(frame, mouse.mousePos);
    fs.writeFileSync(`${base}_submit.json`, JSON.stringify(submit, null, 2));
    last = { state, mouse, submit, base };
    console.log(`[${attempt}/${args.attempts}] submit events:`, JSON.stringify(submit.events));
    await page.goto('https://jzt.jd.com/home/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    const visible = await waitLoginVisible(page, args.username, 12000);
    fs.writeFileSync(`${base}_visible.json`, JSON.stringify(visible, null, 2));
    if (visible.ok) {
      console.log(`LOGIN_OK username=${args.username}`);
      console.log(`URL=${visible.url}`);
      console.log(`OUTPUT_PREFIX=${base}`);
      if (!args.keepOpen) await context.close();
      return;
    }
    console.log(`[${attempt}/${args.attempts}] not logged in yet, retrying...`);
  }
  console.error('LOGIN_NOT_CONFIRMED');
  if (last) console.error(`Last output prefix: ${last.base}`);
  if (!args.keepOpen) await context.close();
  process.exit(1);
}

main().catch(err => {
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});
