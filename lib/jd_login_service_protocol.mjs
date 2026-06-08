#!/usr/bin/env node
import fs from 'node:fs';
import crypto from 'node:crypto';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';
const BASE = 'https://passport.jd.com';
const DEFAULT_REFERER = 'https://passport.jd.com/common/loginPage?from=jbm_jd&ReturnUrl=https%3A%2F%2Fjzt.jd.com%2Fhome%2F';
const DEFAULT_SSO = 'sso.jingdong.com,sso.jdpay.com,ssa.7fresh.com,sso.vipmro.net,sso.vipmro.com,sso.healthjd.com,sso.jdl.com,sso.jingxi.com,sso.jdh.com,sso.jhscm.com,sso.jkcsjd.com,sso.jdcloud.com,sso.yiyaojd.com,sso.jddj.com,sso.jingdonghealth.cn,sso.jd.hk';

function parseArgs(argv){
  const args={bridgeLog:'work/protocol_chain/login_bridge_log.json', stateJson:'', cookie:'', username:'', password:'', authcode:'', h5st:'', stk:'', out:'work/protocol_chain/login_service_protocol_result.json', dryRun:false, useState:false};
  for(let i=2;i<argv.length;i++){
    const a=argv[i]; if(a==='--dry-run'){args.dryRun=true; continue;} if(a==='--use-state'){args.useState=true; continue;} if(!a.startsWith('--')) continue;
    const k=a.slice(2).replace(/-([a-z])/g,(_,c)=>c.toUpperCase()); args[k]=argv[++i];
  }
  return args;
}
function readJson(path){ return path ? JSON.parse(fs.readFileSync(path,'utf8')) : null; }
function lastLoginAjax(log){
  const ajax=log?.log?.ajax||[];
  for(let i=ajax.length-1;i>=0;i--) if(ajax[i].url?.includes('/common/loginService') && ajax[i].data) return ajax[i];
  return null;
}
function rsaEncrypt(password, pubKeyB64){
  const pem='-----BEGIN PUBLIC KEY-----\n'+String(pubKeyB64).match(/.{1,64}/g).join('\n')+'\n-----END PUBLIC KEY-----';
  return crypto.publicEncrypt({key:pem,padding:crypto.constants.RSA_PKCS1_PADDING}, Buffer.from(password,'utf8')).toString('base64');
}
function formEncode(obj){ return new URLSearchParams(Object.entries(obj).map(([k,v])=>[k,String(v??'')])).toString(); }
function hiddenMap(state){
  const h=state?.hidden || state?.hiddenMap || {};
  if(Array.isArray(h)) return Object.fromEntries(h.map(x=>[x[0]||x[1], x[2] ?? x[1] ?? '']));
  return h || {};
}
function buildFromState(state,args,templateData={}){
  const h=hiddenMap(state);
  const pubKey=h.pubKey || state.pubKey || templateData.pubKey;
  const loginname=args.username || state.originValue || templateData.loginname || 'your_username';
  const data={
    uuid: h.uuid || state.uuid || templateData.uuid || '',
    eid: h.eid || state.eid || templateData.eid || '',
    fp: h.sessionId || state.fp || templateData.fp || '',
    eid2: h.eid2 || state.jstk || templateData.eid2 || '',
    _t: h.token || h._t || templateData._t || '_t',
    loginname,
    nloginpwd: rsaEncrypt(args.password, pubKey),
    authcode: args.authcode || state.validate || state.authcode || templateData.authcode || '',
    pubKey,
    sa_token: h.sa_token || state.sa_token || templateData.sa_token || '',
    seqSid: state.sessionId || state.seqSid || templateData.seqSid || '',
    useSlideAuthCode: h.useSlideAuthCode || state.useSlideAuthCode || templateData.useSlideAuthCode || '1',
    bind: h.bind || state.bind || templateData.bind || '',
    pageSource: h.pageSource || state.pageSource || templateData.pageSource || 'commonLogin',
    pageLocation: h.pageLocation || state.pageLocation || templateData.pageLocation || 'https://jzt.jd.com/',
    ssoDomains: state.ssoDomains || templateData.ssoDomains || DEFAULT_SSO,
  };
  const jwt=h.graphicCaptchaJwtToken || state.graphicCaptchaJwtToken || templateData.graphicCaptchaJwtToken;
  if(jwt) data.graphicCaptchaJwtToken=jwt;
  data.h5st=args.h5st || state.h5st || state.sign?.h5st || templateData.h5st || '';
  data._stk=args.stk || state._stk || state.sign?._stk || templateData._stk || '';
  return data;
}
async function post(url,data,cookie){
  const full=url.startsWith('http')?url:BASE+url;
  const headers={'user-agent':UA,'accept':'*/*','content-type':'application/x-www-form-urlencoded; charset=UTF-8','origin':BASE,'referer':DEFAULT_REFERER,'x-requested-with':'XMLHttpRequest'};
  if(cookie) headers.cookie=cookie;
  const res=await fetch(full,{method:'POST',headers,body:formEncode(data)});
  return {status:res.status, headers:Object.fromEntries(res.headers.entries()), text:await res.text()};
}
const args=parseArgs(process.argv);
const bridge=args.bridgeLog && fs.existsSync(args.bridgeLog) ? readJson(args.bridgeLog) : null;
const rec=bridge ? lastLoginAjax(bridge) : null;
const state=readJson(args.stateJson);
let data;
let url=rec?.url || '/common/loginService?nr=1&r='+Math.random()+'&from=jbm_jd&ReturnUrl=https%3A%2F%2Fjzt.jd.com%2Fhome%2F';
if(args.useState || state?.hidden || state?.hiddenMap){ data=buildFromState(state||{},args,rec?.data||{}); }
else { data={...(rec?.data||{})}; if(args.username) data.loginname=args.username; if(args.password) data.nloginpwd=rsaEncrypt(args.password,data.pubKey); if(args.authcode) data.authcode=args.authcode; if(args.h5st) data.h5st=args.h5st; if(args.stk) data._stk=args.stk; }
let cookie=args.cookie || state?.cookie || '';
const result={url,data,cookie_used:!!cookie,rsa_len:data.nloginpwd?.length};
if(!args.dryRun){ const r=await post(url,data,cookie); result.status=r.status; result.response_text=r.text; try{result.response_eval_json=JSON.parse(r.text.trim().startsWith('(')?r.text.trim().slice(1,-1):r.text);}catch{} }
fs.writeFileSync(args.out, JSON.stringify(result,null,2));
console.log(JSON.stringify(result,null,2));
