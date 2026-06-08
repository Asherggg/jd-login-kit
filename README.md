# jd-login-kit

可移植的京准通登录 / JD 滑块验证码本地工具包。

> 这个仓库只保存源码和运行说明，不保存账号、密码、cookie、历史验证码 state、登录结果等敏感运行数据。

## 功能

- 浏览器原生登录流程：打开登录页、输入账号密码、触发滑块、生成轨迹、在浏览器内调用 `jdSlide.submit()`，让浏览器自己完成 `s.html`、`loginService`、cookie 写入和跳转。
- 纯协议工具：保留 `lib/jd_iv_protocol.py` 和 `lib/jd_login_service_protocol.mjs`，便于调试验证码和登录接口。

## 环境要求

- Node.js 18+
- Python 3.10+
- Chrome/Chromium，或 Playwright 自动安装的 Chromium

## 首次安装

```bash
git clone <your-private-repo-url>
cd jd-login-kit
npm install
npm run install:browsers
python3 -m pip install -r requirements.txt
```

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
lib/jd_login_service_protocol.mjs  # Node 版 /common/loginService 纯协议提交
lib/dump_fresh_with_seq.js         # 浏览器 iframe 内 fresh state/seq 抓取脚本
scripts/login_browser_native.mjs   # 推荐入口：浏览器原生登录自动化
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
