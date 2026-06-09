import crypto from 'node:crypto';

export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';
export const PASSPORT_BASE = 'https://passport.jd.com';
export const DEFAULT_RETURN_URL = 'https://jzt.jd.com/home/';
export const DEFAULT_FROM = 'jbm_jd';
export const DEFAULT_SSO = 'sso.jingdong.com,sso.jdpay.com,ssa.7fresh.com,sso.vipmro.net,sso.vipmro.com,sso.healthjd.com,sso.jdl.com,sso.jingxi.com,sso.jdh.com,sso.jkcsjd.com,sso.jdcloud.com,sso.yiyaojd.com,sso.jddj.com,sso.jingdonghealth.cn,sso.jd.hk';

export function loginPageUrl(returnUrl = DEFAULT_RETURN_URL, from = DEFAULT_FROM) {
  return `${PASSPORT_BASE}/common/loginPage?from=${encodeURIComponent(from)}&ReturnUrl=${encodeURIComponent(returnUrl)}`;
}

export function decodeHtmlEntities(value = '') {
  return String(value)
    .replace(/&#x([0-9a-f]+);?/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);?/g, (_, dec) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function attrValue(tag, name) {
  const re = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const m = tag.match(re);
  return decodeHtmlEntities(m?.[2] ?? m?.[3] ?? m?.[4] ?? '');
}

export function parseHiddenInputs(html) {
  const out = {};
  for (const m of String(html).matchAll(/<input\b[^>]*>/gi)) {
    const tag = m[0];
    const id = attrValue(tag, 'id');
    const name = attrValue(tag, 'name');
    if (!id && !name) continue;
    const value = attrValue(tag, 'value');
    if (name) out[name] = value;
    if (id) out[id] = value;
  }
  return out;
}

export function parseJsonp(text) {
  const trimmed = String(text).trim();
  const m = trimmed.match(/^[\w.$]+\((.*)\)\s*;?$/s);
  if (m) return JSON.parse(m[1]);
  if (trimmed.startsWith('(') && trimmed.endsWith(')')) return JSON.parse(trimmed.slice(1, -1));
  return JSON.parse(trimmed);
}

export function parseSeqSessionId(text) {
  return String(text || '').match(/\b_jdtdmap_sessionId\s*=\s*["'](\d+)["']/)?.[1] || '';
}

export function splitSetCookieString(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap(splitSetCookieString);
  const text = String(value);
  const parts = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== ',') continue;
    const rest = text.slice(i + 1);
    if (/^\s*[A-Za-z0-9_.-]+\s*=/.test(rest)) {
      parts.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  const last = text.slice(start).trim();
  if (last) parts.push(last);
  return parts;
}

export function setCookiesFromHeaders(headers) {
  if (!headers) return [];
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  if (typeof headers.get === 'function') return splitSetCookieString(headers.get('set-cookie'));
  return [];
}

export class CookieJar {
  constructor(initial = undefined) {
    this.cookies = new Map();
    if (initial) {
      if (typeof initial === 'string') this.mergeCookieHeader(initial);
      else if (Array.isArray(initial)) this.mergeSetCookie(initial);
      else if (typeof initial === 'object') {
        for (const [k, v] of Object.entries(initial)) this.set(k, v);
      }
    }
  }

  set(name, value) {
    if (!name) return;
    this.cookies.set(String(name), String(value ?? ''));
  }

  mergeCookieHeader(header) {
    for (const part of String(header || '').split(';')) {
      const idx = part.indexOf('=');
      if (idx <= 0) continue;
      this.set(part.slice(0, idx).trim(), part.slice(idx + 1).trim());
    }
  }

  mergeSetCookie(setCookie) {
    for (const line of splitSetCookieString(setCookie)) {
      const first = line.split(';', 1)[0];
      const idx = first.indexOf('=');
      if (idx <= 0) continue;
      this.set(first.slice(0, idx).trim(), first.slice(idx + 1).trim());
    }
  }

  mergeResponseHeaders(headers) {
    this.mergeSetCookie(setCookiesFromHeaders(headers));
  }

  header() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  names() {
    return [...this.cookies.keys()];
  }

  toJSON({ redact = false } = {}) {
    const out = {};
    for (const [k, v] of this.cookies.entries()) out[k] = redact ? `<redacted:${String(v).length}>` : v;
    return out;
  }
}

export function seedJdAnalyticsCookies(jar, { nowMs = Date.now(), visitorId = '' } = {}) {
  const nowSec = Math.floor(Number(nowMs) / 1000);
  const uid = visitorId || `${nowMs}${Math.floor(Math.random() * 1e10).toString().padStart(10, '0')}`;
  jar.set('__jdc', '95931165');
  jar.set('__jdu', uid);
  jar.set('__jdv', `95931165|direct|-|none|-|${nowMs}`);
  jar.set('__jda', `95931165.${uid}.${nowSec}.${nowSec}.${nowSec}.1`);
  jar.set('__jdb', `95931165.1.${uid}|1.${nowSec}`);
  return jar;
}

export function rsaEncrypt(password, pubKeyB64) {
  if (!pubKeyB64) throw new Error('missing pubKey');
  const chunks = String(pubKeyB64).match(/.{1,64}/g);
  if (!chunks) throw new Error('invalid pubKey');
  const pem = `-----BEGIN PUBLIC KEY-----\n${chunks.join('\n')}\n-----END PUBLIC KEY-----`;
  return crypto.publicEncrypt(
    { key: pem, padding: crypto.constants.RSA_PKCS1_PADDING },
    Buffer.from(String(password), 'utf8'),
  ).toString('base64');
}

export function formEncode(obj) {
  return new URLSearchParams(Object.entries(obj).map(([k, v]) => [k, String(v ?? '')])).toString();
}

export function buildLoginServiceData({
  hidden = {},
  username,
  password,
  authcode,
  seqSid = '',
  pageLocation = 'https://jzt.jd.com/',
  ssoDomains = DEFAULT_SSO,
  h5st = '',
  stk = '',
  rsaEncryptFn = rsaEncrypt,
}) {
  const sessionId = hidden.sessionId || hidden.fp || '';
  const pubKey = hidden.pubKey || '';
  const data = {
    uuid: hidden.uuid || '',
    eid: hidden.eid || '',
    fp: sessionId,
    eid2: hidden.eid2 || '',
    _t: hidden.token || hidden._t || '_t',
    loginname: username || hidden.loginname || '',
    nloginpwd: rsaEncryptFn(password, pubKey),
    authcode: authcode || '',
    pubKey,
    sa_token: hidden.sa_token || '',
    seqSid: seqSid || hidden.seqSid || sessionId,
    useSlideAuthCode: hidden.useSlideAuthCode || '1',
    bind: hidden.bind || '',
    pageSource: hidden.pageSource || 'commonLogin',
    pageLocation: hidden.pageLocation || pageLocation,
    ssoDomains,
    h5st,
    _stk: stk,
  };
  if (hidden.graphicCaptchaJwtToken) data.graphicCaptchaJwtToken = hidden.graphicCaptchaJwtToken;
  return data;
}

export function buildPythonSolverArgs({
  scriptPath,
  hidden = {},
  cookieHeader = '',
  username = '',
  pageUrl = loginPageUrl(),
  outPrefix,
  appId = hidden.slideAppId || hidden.appId || '1604ebb2287',
  scene = 'login',
  product = 'click-bind-suspend',
  warmSeq = false,
  passwordLen = undefined,
  solver = '',
  captchaMinConfidence = undefined,
  distanceOffsets = undefined,
  trajectoryVariants = undefined,
  ddddocrPresets = undefined,
  ddddocrCoordinate = undefined,
  ddddocrMinConfidence = undefined,
  ddddocrDistanceRange = undefined,
  ddddocrBenchmarkJson = undefined,
  captchaSkipLowQuality = false,
  captchaDistanceRange = undefined,
  captchaMaxBuiltinDelta = undefined,
}) {
  const sessionId = hidden.sessionId || hidden.fp || '';
  const args = [
    scriptPath,
    '--app-id', appId,
    '--scene', scene,
    '--product', product,
    '--eid', hidden.eid || '',
    '--jstk', hidden.eid2 || hidden.jstk || '',
    '--session-id', sessionId,
    '--origin', username,
    '--return-url', encodeURIComponent(pageUrl),
    '--cookie', cookieHeader,
    '--out', outPrefix,
    '--rewrite-seq-time',
  ];
  if (warmSeq) args.push('--warm-seq');
  if (passwordLen != null) args.push('--password-len', String(passwordLen));
  if (solver) args.push('--solver', String(solver));
  if (captchaMinConfidence != null) args.push('--captcha-min-confidence', String(captchaMinConfidence));
  if (distanceOffsets != null) args.push('--distance-offsets', String(distanceOffsets));
  if (trajectoryVariants != null) args.push('--trajectory-variants', String(trajectoryVariants));
  if (ddddocrPresets) args.push('--ddddocr-presets', String(ddddocrPresets));
  if (ddddocrCoordinate) args.push('--ddddocr-coordinate', String(ddddocrCoordinate));
  if (ddddocrMinConfidence) args.push('--ddddocr-min-confidence', String(ddddocrMinConfidence));
  if (ddddocrDistanceRange) args.push('--ddddocr-distance-range', String(ddddocrDistanceRange));
  if (ddddocrBenchmarkJson) args.push('--ddddocr-benchmark-json', String(ddddocrBenchmarkJson));
  if (captchaSkipLowQuality) args.push('--captcha-skip-low-quality');
  if (captchaDistanceRange != null) args.push('--captcha-distance-range', String(captchaDistanceRange));
  if (captchaMaxBuiltinDelta != null) args.push('--captcha-max-builtin-delta', String(captchaMaxBuiltinDelta));
  return args;
}

export function isRetryableSlideSolverError(error) {
  const text = String(error?.stack || error?.message || error || '');
  if (!/python slide solver failed/i.test(text)) return false;
  return /decode_image|base64\.b64decode|UnidentifiedImageError|cannot identify image file|Incorrect padding|Invalid base64/i.test(text);
}
