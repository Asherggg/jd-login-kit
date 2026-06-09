import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CookieJar,
  buildPythonSolverArgs,
  buildLoginServiceData,
  parseSeqSessionId,
  loginPageUrl,
  parseHiddenInputs,
  parseJsonp,
  seedJdAnalyticsCookies,
} from '../lib/jd_http_protocol.mjs';

test('parseHiddenInputs reads name/id aliases and decodes entity values', () => {
  const html = `
    <input type="hidden" name="uuid" value="abc&amp;1">
    <input type="hidden" id="sessionId" name="fp" value="sid-001">
    <input id="pubKey" value="PUB&#x2B;KEY">
    <input name="empty">
  `;

  const hidden = parseHiddenInputs(html);

  assert.equal(hidden.uuid, 'abc&1');
  assert.equal(hidden.fp, 'sid-001');
  assert.equal(hidden.sessionId, 'sid-001');
  assert.equal(hidden.pubKey, 'PUB+KEY');
  assert.equal(hidden.empty, '');
});

test('CookieJar merges comma-joined Set-Cookie headers without corrupting Expires commas', () => {
  const jar = new CookieJar();

  jar.mergeSetCookie('a=1; Expires=Wed, 21 Oct 2030 07:28:00 GMT; Path=/, b=two; Path=/; HttpOnly');
  assert.equal(jar.header(), 'a=1; b=two');

  jar.mergeSetCookie(['a=2; Path=/', 'c=3; Domain=.jd.com']);
  assert.equal(jar.header(), 'a=2; b=two; c=3');
  assert.deepEqual(jar.names(), ['a', 'b', 'c']);
});

test('parseJsonp accepts callback wrappers and bare JSON', () => {
  assert.deepEqual(parseJsonp('jsonp_1({"success":1});'), { success: 1 });
  assert.deepEqual(parseJsonp('({"success":"https://sso.example/"})'), { success: 'https://sso.example/' });
  assert.deepEqual(parseJsonp('{"success":0}'), { success: 0 });
});

test('buildLoginServiceData uses parsed hidden fields and injected encryptor', () => {
  const hidden = {
    uuid: 'uuid-1',
    eid: 'eid-1',
    sessionId: 'sid-1',
    eid2: 'jstk-1',
    pubKey: 'PUBKEY',
    token: 'token-1',
    sa_token: 'sa-1',
    graphicCaptchaJwtToken: 'jwt-1',
  };

  const data = buildLoginServiceData({
    hidden,
    username: 'jd_mercury',
    password: 'secret',
    authcode: 'validate-token',
    seqSid: 'seq-001',
    rsaEncryptFn: (password, pubKey) => `enc:${password}:${pubKey}`,
  });

  assert.equal(data.loginname, 'jd_mercury');
  assert.equal(data.nloginpwd, 'enc:secret:PUBKEY');
  assert.equal(data.authcode, 'validate-token');
  assert.equal(data.uuid, 'uuid-1');
  assert.equal(data.eid, 'eid-1');
  assert.equal(data.fp, 'sid-1');
  assert.equal(data.seqSid, 'seq-001');
  assert.equal(data.eid2, 'jstk-1');
  assert.equal(data._t, 'token-1');
  assert.equal(data.sa_token, 'sa-1');
  assert.equal(data.graphicCaptchaJwtToken, 'jwt-1');
  assert.equal(data.useSlideAuthCode, '1');
});

test('loginPageUrl builds the same passport entry used by JZT', () => {
  assert.equal(
    loginPageUrl('https://jzt.jd.com/home/'),
    'https://passport.jd.com/common/loginPage?from=jbm_jd&ReturnUrl=https%3A%2F%2Fjzt.jd.com%2Fhome%2F',
  );
});

test('buildPythonSolverArgs maps hidden login tokens into iv.jd.com protocol args', () => {
  const args = buildPythonSolverArgs({
    scriptPath: 'lib/jd_iv_protocol.py',
    hidden: {
      eid: 'eid-1',
      eid2: 'jstk-1',
      sessionId: 'sid-1',
      slideAppId: 'app-1',
    },
    cookieHeader: 'a=1',
    username: 'jd_mercury',
    pageUrl: 'https://passport.jd.com/common/loginPage?x=1',
    outPrefix: 'outputs/out',
  });

  assert.deepEqual(args, [
    'lib/jd_iv_protocol.py',
    '--app-id', 'app-1',
    '--scene', 'login',
    '--product', 'click-bind-suspend',
    '--eid', 'eid-1',
    '--jstk', 'jstk-1',
    '--session-id', 'sid-1',
    '--origin', 'jd_mercury',
    '--return-url', encodeURIComponent('https://passport.jd.com/common/loginPage?x=1'),
    '--cookie', 'a=1',
    '--out', 'outputs/out',
    '--rewrite-seq-time',
  ]);
});

test('buildPythonSolverArgs forwards explicit slide solver selection', () => {
  const args = buildPythonSolverArgs({
    scriptPath: 'lib/jd_iv_protocol.py',
    hidden: { eid: 'eid-1', eid2: 'jstk-1', sessionId: 'sid-1' },
    username: 'jd_mercury',
    outPrefix: 'outputs/out',
    solver: 'ddddocr',
  });

  assert.equal(args.at(-2), '--solver');
  assert.equal(args.at(-1), 'ddddocr');
});


test('buildPythonSolverArgs forwards captcha strategy tuning options', () => {
  const args = buildPythonSolverArgs({
    scriptPath: 'lib/jd_iv_protocol.py',
    hidden: { eid: 'eid-1', eid2: 'jstk-1', sessionId: 'sid-1' },
    username: 'jd_mercury',
    outPrefix: 'outputs/out',
    solver: 'captcha-recognizer',
    captchaMinConfidence: 0.8,
    distanceOffsets: '0,-1,1',
    trajectoryVariants: 3,
  });

  assert.deepEqual(args.slice(-8), [
    '--solver', 'captcha-recognizer',
    '--captcha-min-confidence', '0.8',
    '--distance-offsets', '0,-1,1',
    '--trajectory-variants', '3',
  ]);
});



test('buildPythonSolverArgs forwards ddddocr tuned options', () => {
  const args = buildPythonSolverArgs({
    scriptPath: 'lib/jd_iv_protocol.py',
    hidden: { eid: 'eid-1', eid2: 'jstk-1', sessionId: 'sid-1' },
    username: 'jd_mercury',
    outPrefix: 'outputs/out',
    solver: 'ddddocr-tuned',
    ddddocrPresets: 'alpha-crop-simple,roi-y-simple',
    ddddocrCoordinate: 'auto',
    ddddocrMinConfidence: 0.2,
    ddddocrDistanceRange: '45,135',
    ddddocrBenchmarkJson: 'outputs/ddddocr_tuning_summary.json',
  });

  assert.deepEqual(args.slice(-12), [
    '--solver', 'ddddocr-tuned',
    '--ddddocr-presets', 'alpha-crop-simple,roi-y-simple',
    '--ddddocr-coordinate', 'auto',
    '--ddddocr-min-confidence', '0.2',
    '--ddddocr-distance-range', '45,135',
    '--ddddocr-benchmark-json', 'outputs/ddddocr_tuning_summary.json',
  ]);
});

test('parseSeqSessionId extracts jd seq session id', () => {
  assert.equal(
    parseSeqSessionId('var _jdtdmap_sessionId="4971126450824985710";var _jdtdseq_config_data={}'),
    '4971126450824985710',
  );
  assert.equal(parseSeqSessionId('no seq id'), '');
});

test('seedJdAnalyticsCookies creates browser-compatible __jd cookie family', () => {
  const jar = new CookieJar();

  seedJdAnalyticsCookies(jar, { nowMs: 1780989038678, visitorId: '17809890386771438649468' });

  assert.equal(jar.cookies.get('__jdc'), '95931165');
  assert.equal(jar.cookies.get('__jdu'), '17809890386771438649468');
  assert.equal(jar.cookies.get('__jdv'), '95931165|direct|-|none|-|1780989038678');
  assert.equal(jar.cookies.get('__jda'), '95931165.17809890386771438649468.1780989038.1780989038.1780989038.1');
  assert.equal(jar.cookies.get('__jdb'), '95931165.1.17809890386771438649468|1.1780989038');
});
