/**
 * Fresh JD login/captcha state dumper with real seq capture.
 * Run inside passport.jd.com login iframe.
 *
 *   const state = await jdIvFreshLoginAndDump({username:'your_username', password:'your_password'});
 */
async function jdIvFreshLoginAndDump(options = {}) {
  const opts = Object.assign({
    username: '',
    password: '',
    triggerLogin: true,
    refreshCaptcha: false,
    timeoutMs: 10000,
    tokenTimeoutMs: 3000,
  }, options || {});

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const q = sel => document.querySelector(sel);
  const fire = (el, type, init = {}) => el && el.dispatchEvent(new Event(type, Object.assign({ bubbles: true }, init)));
  const fireKey = (el, type, key = 'a') => el && el.dispatchEvent(new KeyboardEvent(type, { bubbles: true, key }));

  window.__jdIvSeqObjs = [];
  window.__jdIvEvents = [];
  window.__jdIvJsonp = [];

  function clone(v) { try { return JSON.parse(JSON.stringify(v)); } catch (_) { return String(v); } }

  if (typeof window.joinReturnObj === 'function' && !window.joinReturnObj.__jdIvWrapped) {
    const orig = window.joinReturnObj;
    function wrappedJoinReturnObj(...args) {
      const ret = orig.apply(this, args);
      window.__jdIvSeqObjs.push({ ts: Date.now(), args: clone(args), ret: clone(ret) });
      return ret;
    }
    wrappedJoinReturnObj.__jdIvWrapped = true;
    window.joinReturnObj = wrappedJoinReturnObj;
  }

  ['focus', 'blur', 'input', 'change', 'keyup', 'click', 'mousedown', 'mousemove', 'mouseup'].forEach(type => {
    document.addEventListener(type, e => {
      const id = e.target && (e.target.id || e.target.className || e.target.tagName);
      if (/loginname|nloginpwd|submit|JDJRV|slide|img/i.test(String(id))) {
        window.__jdIvEvents.push({ ts: Date.now(), type, id: String(id), x: e.clientX, y: e.clientY, isTrusted: e.isTrusted });
      }
    }, true);
  });

  const startReady = Date.now();
  while (Date.now() - startReady < opts.timeoutMs) {
    if (q('#loginname') && q('#nloginpwd')) break;
    await sleep(100);
  }

  const u = q('#loginname');
  const p = q('#nloginpwd');
  if (!u || !p) throw new Error('login inputs not found');

  u.focus();
  u.value = opts.username;
  fire(u, 'input'); fire(u, 'change'); fireKey(u, 'keyup', 'a');
  await sleep(80);
  p.focus();
  p.value = opts.password;
  fire(p, 'input'); fire(p, 'change'); fireKey(p, 'keyup', 'a');
  await sleep(120);

  if (opts.triggerLogin) {
    // Prefer the real submit button path so seq.js records sniffL/blur/click-adjacent
    // behavior. Falling back to loginSubmit() works, but tends to miss browser seq.
    const btn = q('#paipaiLoginSubmit') || q('#loginsubmit');
    try {
      if (btn) {
        btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 10, clientY: 10 }));
        btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 10, clientY: 10 }));
        btn.click();
      } else if (typeof window.loginSubmit === 'function') {
        window.loginSubmit();
      }
    } catch (_) {
      if (typeof window.loginSubmit === 'function') window.loginSubmit();
    }
  }

  const startCaptcha = Date.now();
  while (Date.now() - startCaptcha < opts.timeoutMs) {
    if (window.jdSlide && document.body.innerText.includes('拼图')) break;
    await sleep(100);
  }
  const a = window.jdSlide;
  if (!a) throw new Error('window.jdSlide not found after login trigger');

  if (a && !a.__jdIvJsonpWrapped && typeof a.jsonp === 'function') {
    const oldJsonp = a.jsonp;
    a.__jdIvJsonpWrapped = true;
    a.jsonp = function(url, data, cbKey, cb, extra) {
      const rec = { ts: Date.now(), url, data: clone(data || {}), cbKey };
      window.__jdIvJsonp.push(rec);
      const wrappedCb = typeof cb === 'function' ? function(resp) {
        rec.response = clone(resp);
        return cb.apply(this, arguments);
      } : cb;
      return oldJsonp.call(this, url, data, cbKey, wrappedCb, extra);
    };
  }

  function imgs(root) {
    return Array.from((root || document).querySelectorAll('img[src]'))
      .filter(img => /data:image\/png|\.png(\?|$)|\.webp(\?|$)|\.jpg(\?|$)/i.test(img.src))
      .map(img => {
        const r = img.getBoundingClientRect();
        return { src: img.src, naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight, rect: { left: r.left, top: r.top, width: r.width, height: r.height } };
      });
  }

  const oldChallenge = a.validateID || '';
  if (opts.refreshCaptcha && typeof a.getValidateImage === 'function') a.getValidateImage();
  let im = [];
  const startImg = Date.now();
  while (Date.now() - startImg < opts.timeoutMs) {
    im = imgs(a.slideWrap || document);
    const changedOk = !opts.refreshCaptcha || (a.validateID && a.validateID !== oldChallenge);
    if (changedOk && a.validateID && im.length >= 2) break;
    await sleep(100);
  }
  im = imgs(a.slideWrap || document);
  if (im.length < 2 && typeof a.verify === 'function') {
    a.verify();
    const st = Date.now();
    while (Date.now() - st < opts.timeoutMs) {
      im = imgs(a.slideWrap || document);
      if (a.validateID && im.length >= 2) break;
      await sleep(100);
    }
  }

  let eid = q('#eid')?.value || '';
  let jstk = q('#eid2')?.value || '';
  try {
    const token = await new Promise(resolve => {
      let done = false;
      const timer = setTimeout(() => { if (!done) { done = true; resolve(null); } }, opts.tokenTimeoutMs);
      try {
        window.getJsToken(function(ret) { if (!done) { done = true; clearTimeout(timer); resolve(ret || null); } }, opts.tokenTimeoutMs);
      } catch (_) { if (!done) { done = true; clearTimeout(timer); resolve(null); } }
    });
    if (token && token.jsToken) jstk = token.jsToken;
    if (!eid && token && token.eid) eid = token.eid;
  } catch (_) {}

  const slideRect = a.slideBtn?.getBoundingClientRect ? a.slideBtn.getBoundingClientRect() : { left: 0, top: 0, width: 0, height: 0 };
  let left = Math.round(slideRect.left || 0), top = Math.round(slideRect.top || 0);
  try { left = Number(a.getLeft(a.slideBtn)); } catch (_) {}
  try { top = Number(a.getTop(a.slideBtn)); } catch (_) {}

  return {
    dumpedAt: new Date().toISOString(),
    href: location.href,
    cookie: document.cookie,
    params: a.params || {},
    oldChallenge,
    challenge: a.validateID,
    width: a.width,
    y: a.y,
    imgRatio: a.imgRatio,
    eid,
    jstk,
    sessionId: (typeof window._jdtdmap_sessionId !== 'undefined' ? window._jdtdmap_sessionId : q('#sessionId')?.value || ''),
    originValue: u.value || opts.username,
    selenium: navigator.webdriver ? '1' : '0',
    urlParam: encodeURIComponent(location.href),
    oElementId: a.o,
    slideBtn: { rect: { left: slideRect.left || 0, top: slideRect.top || 0, width: slideRect.width || 0, height: slideRect.height || 0 }, left, top },
    imgs: im,
    seqObjs: window.__jdIvSeqObjs,
    browserEvents: window.__jdIvEvents,
    jsonpLog: window.__jdIvJsonp,
  };
}

if (typeof window !== 'undefined') window.jdIvFreshLoginAndDump = jdIvFreshLoginAndDump;
