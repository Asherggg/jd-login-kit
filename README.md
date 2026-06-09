# jd-login-kit

可移植的京准通登录 / JD 滑块验证码本地工具包。

> 这个仓库只保存源码和运行说明，不保存账号、密码、cookie、历史验证码 state、登录结果等敏感运行数据。

## 功能

- 浏览器原生登录流程：打开登录页、输入账号密码、触发滑块、生成轨迹、在浏览器内调用 `jdSlide.submit()`，让浏览器自己完成 `s.html`、`loginService`、cookie 写入和跳转。
- 无浏览器内核协议登录流程：不用 Playwright/Chrome/Edge，直接用 Node HTTP + Node VM 复现 `pc-tk.js` 指纹 token，用 Python 识别滑块并走 `/slide/g.html`、`/slide/s.html`、`/common/loginService`。
- 纯协议工具：保留 `lib/jd_iv_protocol.py` 和 `lib/jd_login_service_protocol.mjs`，便于调试验证码和登录接口。

## 环境要求

- Node.js 18+
- Python 3.10+
- 无浏览器协议入口不需要 Chrome/Chromium；浏览器原生入口才需要 Chrome/Chromium，或 Playwright 自动安装的 Chromium

## 首次安装

```bash
git clone https://github.com/Asherggg/jd-login-kit.git
cd jd-login-kit
npm install
python3 -m pip install -r requirements.txt
```

如果要使用浏览器原生入口，再安装 Playwright 浏览器：

```bash
npm run install:browsers
```

## 无浏览器内核协议登录

```bash
npm run login:http -- --username "your_username" --password "your_password"
```

或使用环境变量，避免密码进入 shell 历史：

```bash
export JD_USERNAME="your_username"
export JD_PASSWORD="your_password"
npm run login:http -- --attempts 8
```

这个入口不会启动 Playwright/Chrome/Edge。它会：

1. 纯 HTTP 拉取 `passport.jd.com/common/loginPage`；
2. 在 Node VM 里执行 `pc-tk.js`，生成 `eid/eid2/fp/_gia_d`；
3. 拉取 `seq.jd.com/jseqf.html` 得到 `_jdtdmap_sessionId`；
4. Python 协议调用 `/slide/g.html`、识别图片距离、提交 `/slide/s.html`；
5. 带 `validate/authcode` POST `/common/loginService`，并跟随 SSO URL 收集登录 cookie。

成功输出示例：

```txt
LOGIN_OK_HTTP_PROTOCOL
OUTPUT_PREFIX=D:\coding\project\jd-login-kit\outputs\...
COOKIE_NAMES=_t,3AB9...,thor,pin,unick,_pst,...
```

说明：

- 默认会发送协议版 seq 行为日志，降低 `newSafeVerify` 概率；调试时可加 `--no-warm-seq` 关闭。
- 滑块服务端偶发 `refuse` 属正常现象，脚本会 fresh challenge 重试；可用 `--attempts 12` 增加次数。
- Recommended slide solver: `--solver captcha-recognizer`. Strategy options: `--captcha-min-confidence 0.8` falls back to builtin on low confidence; `--trajectory-variants 3` retries trajectory variants for `refuse`; `--distance-offsets 0,-1,1,-2,2,-3,3` tries an offset matrix for `fail`.
- `--solver ddddocr` uses `slide_match(..., simple_target=True)` for slider captcha matching; use `--solver ddddocr-normal` only for the legacy `simple_target=False` mode.
- 这个入口拿到的是 HTTP cookie jar，不会自动写入当前 Edge/Chrome 用户数据目录。

## 推荐使用：浏览器原生登录

```bash
npm run login -- --username "your_username" --password "your_password"
```

或使用环境变量：

```bash
cp .env.example .env
# 编辑 .env 后：
export $(grep -v '^#' .env | xargs)
npm run login
```

运行成功时会输出：

```txt
LOGIN_OK username=<账号>
URL=<当前页面>
OUTPUT_PREFIX=outputs/...
```

默认会保留浏览器窗口和 `browser-profile/`，这样同一台电脑下次可以复用登录态。

如果要跑完自动关闭浏览器：

```bash
npm run login -- --username "xxx" --password "yyy" --no-keep-open
```

如果服务器临时拒绝某轮验证码，可增加尝试次数：

```bash
npm run login -- --username "xxx" --password "yyy" --attempts 5
```

## 输出文件

运行数据写入：

```txt
outputs/
```

包括：

- `*_state.json`：当前验证码和浏览器 state
- `*_mouse.json`：本地识别出来的轨迹
- `*_submit.json`：浏览器内提交事件
- `*_visible.json`：最终页面是否识别登录

这些文件已被 `.gitignore` 排除，不会提交到 GitHub。

## 清理本地运行数据

```bash
npm run clean
```

会清理：

- `outputs/`
- `browser-profile/`

## 纯协议调试

验证码轨迹 dry-run：

```bash
python3 lib/jd_iv_protocol.py \
  --live-json outputs/xxx_state.json \
  --out outputs/debug \
  --dry-run \
  --rewrite-seq-time
```

纯协议登录接口调试：

```bash
node lib/jd_login_service_protocol.mjs \
  --use-state \
  --state-json outputs/xxx_state.json \
  --username "xxx" \
  --password "yyy" \
  --authcode "validate" \
  --out outputs/login_result.json
```

注意：纯协议成功不等于浏览器页面登录成功。要让浏览器显示登录状态，请用 `npm run login` 的浏览器原生流程。

## 文件说明

```txt
lib/jd_iv_protocol.py              # Python 版滑块图像识别、轨迹生成、d 参数生成
lib/jd_http_protocol.mjs           # Node 版无浏览器 HTTP/登录字段/cookie 辅助模块
lib/jd_login_service_protocol.mjs  # Node 版 /common/loginService 纯协议提交
lib/dump_fresh_with_seq.js         # 浏览器 iframe 内 fresh state/seq 抓取脚本
scripts/login_browser_native.mjs   # 推荐入口：浏览器原生登录自动化
scripts/login_http_protocol.mjs    # 无浏览器内核协议登录入口
```

## 常见问题

### 1. 看到 `LOGIN_NOT_CONFIRMED` 怎么办？

先重试：

```bash
npm run login -- --username "xxx" --password "yyy" --attempts 5
```

验证码有时会被服务端拒绝，重新 fresh challenge 通常即可。

### 2. 为什么不直接复用 validate？

`validate/authcode` 基本是一次性的。被纯协议或浏览器消费过后，二次提交会返回类似“图形验证码校验失败，请刷新重试”。

### 3. 为什么不直接把老项目整个打包？

老目录包含大量历史 state、cookie、验证码图片和调试结果，不适合作为可迁移仓库。本仓库只保留可运行源码。
