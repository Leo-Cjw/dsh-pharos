# 发布到 npm

> 状态（2026-10-13）：**已发布** [`dsh-pharos@0.6.4`](https://www.npmjs.com/package/dsh-pharos)。
> 首版由 `pnpm publish --access public` 走**浏览器设备授权**（输出一次性 URL + 二维码），
> 不是 6 位 TOTP 码 —— 两种 2FA 交互形态都存在，别照搬另一种的命令。
> 发布后 tarball 有约 1 分钟的 CDN 传播延迟（元数据先可见、`dist.tarball` 暂 404），
> 属正常，不是发布失败。

## 前置：注册与授权

npm 账号是发布的前提，需要在**你自己的机器上、用你的邮箱**完成 —— 涉及凭据，不要由他人代做。

### ① 注册（绕开网页拦截）

`www.npmjs.com` 的注册页走 Cloudflare 人机验证，**在国内网络/某些出口 IP 下会被拦**
（表现为「访问暂时受限 / 您使用的 IP 地址与网络机器人相同」）。

**但注册不必须走网页** —— 直接向 registry API 注册即可：

```bash
pnpm adduser --registry https://registry.npmjs.org
```

会就地提示输入用户名 / 密码 / 邮箱。registry 通道与网页是**两个不同的入口**：
实测 `registry.npmjs.org` 正常（HTTP 200），而被拦的只是 `www.npmjs.com` 网页。

若仍失败，换网络（手机热点最省事，换出口 IP 通常即过）。

### ② 开启 2FA

npm 要求发布者启用双因素认证。在网页 头像 → Account → Two-Factor Authentication 开启，
推荐 authenticator app（而非短信）。

### ③ 生成 Access Token

网页 头像 → **Access Tokens** → Generate New Token。两种选择：

| 类型 | 说明 |
|---|---|
| **Granular Access Token**（推荐） | 可限定读/写、限定包范围、可设过期时间 |
| Classic → Automation | 2FA 环境下也能非交互发布 |

## 发布（本机流程）

```bash
# 1. 确认版本三处一致（package.json / lib/settings-view.js 的 PKG_VERSION / CHANGELOG 顶部）
# 2. 授权（不要把 token 写进仓库）
export NPM_TOKEN=<你的 token>

# 3. 发布（--access public：包名无 scope，公开包免费）
pnpm publish --access public
```

`prepublishOnly` 会自动跑 `sync-settings-view` + 三个测试套件（smoke / host / Windows），
**任一失败即中止发布**。

## 已知坑

### `prepublishOnly` 曾写死 `npm test`

本机（以及任何只有 `pnpm` 没有 npm CLI 的环境）会以
`sh: npm: command not found` + `[ELIFECYCLE] Command failed` 中断发布。
**已改为直接调用 `node`**（`v0.6.4` 之后），使脚本自包含、不依赖包管理器 CLI。

排查手法：`pnpm publish --dry-run --no-git-checks` 干跑，看 `prepublishOnly` 是否通过。

### npm 发布不可撤销

包名一旦发布**不能删除**，仅 24 小时内可 `unpublish`，且同名不能再发。
首次发布前请再确认包名与 `description` 的措辞 —— 首版会永久留在 registry 上。

## 首版发布实录（2026-10-13）

- `pnpm adduser`/`login` 在**国内网络**下走 registry API 可绕开 `www.npmjs.com` 的
  Cloudflare 人机验证（网页被拦、registry 通道正常）。
- 2FA 开启后，pnpm 走**浏览器设备授权**：终端打印一次性 URL + 二维码，浏览器确认即可，
  **不需要输入 6 位 TOTP**。用 `--otp=` 传码是另一条路径（npm CLI 的交互式 TOTP），
  两条不能混用。
- 首次 `publish` 会先创建 `0.0.0-stage` 占位（npm staged publishing 机制），
  设备授权完成后正式版本上架、`latest` 指向正式版；占位包版本号天然最低，不影响用户拉取。
- 校验发布是否真的完成，**不要看 pnpm 的成功提示**，直接查 registry：
  `dist-tags.latest`、`versions` 列表、以及 `dist.tarball` 是否 200。

## 发布后要做的事

- ~~更新 README 安装段~~ ✅ 已完成（v0.6.4 发布后改回推荐方式）。
- 在 DSH 插件市场/CLI 侧验证 `dsh plugin add dsh-pharos` 真能装上。
