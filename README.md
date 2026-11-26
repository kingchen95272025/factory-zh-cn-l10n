# Factory 简体中文语言包工程

为 `/Applications/Factory.app` 构建简体中文语言包，并以「本地补丁」方式注入。仓库负责英文源抽取、翻译管理、质量校验、asar 重打包、完整性哈希更新、重签名与端到端验证。

> 当前基线：**Factory 1.20.0 (build 17041)**，21,007 条英文源串（渲染层 20,857 / 主进程 150）。

## 为什么不能简单替换文件

Factory 是 Electron 应用，且启用了两项会阻止外部注入的 fuse：

- `EnableEmbeddedAsarIntegrityValidation`：启动时校验 `app.asar` 头部的 SHA-256，必须与 `Info.plist` 的 `ElectronAsarIntegrity` 一致。
- `OnlyLoadAppFromAsar`：只从 `app.asar` 加载应用代码，不能用旁路目录替换。

因此补丁流程必须是：**改 asar → 更新 `Info.plist` 头部哈希 → 重新签名**。本仓库把这些步骤全部脚本化。

## 快速开始

```bash
cd tools/factory-zh-cn-l10n
npm install

# 统一 CLI（推荐）
node bin/factory-l10n.mjs status
node bin/factory-l10n.mjs pack              # 为当前应用构建语言包
node bin/factory-l10n.mjs install --quit    # 安装（自动备份+重签）
node bin/factory-l10n.mjs check-update
node bin/factory-l10n.mjs uninstall --quit  # 卸载还原

# 或使用底层脚本
npm run extract
npm run verify
npm test
npm run build
npm run poc
npm run install:patch -- --quit
npm run doctor
npm run restore -- --quit
```

安装后在 **Settings → General → Language** 中选择「简体中文」。未安装补丁时该列表只有原版 8 种语言，这是正常的。

### CLI 命令

| 命令 | 说明 |
|---|---|
| `factory-l10n install` | 安装当前平台最新语言包，自动备份原应用 |
| `factory-l10n uninstall` | 从备份还原原始应用（别名 `restore`） |
| `factory-l10n status` | 应用、语言包、完整性/签名状态 |
| `factory-l10n check-update` | 检查 Factory 版本、已安装补丁与本地/远程语言包更新 |
| `factory-l10n pack` | 抽取当前应用英文源并构建语言包 |
| `factory-l10n list` | 列出检测到的安装与本地语言包 |

通用参数：`--app`、`--pack`、`--state-dir`、`--json`、`--yes`、`--quit`、`--force`、`--remote`。跨平台细节见 [docs/platforms.md](docs/platforms.md)。

## 目录结构

```
catalog/<version>-<build>/        英文源（从 app.asar 静态还原，按命名空间拆分）
  renderer/en/*.json              渲染层 19 个命名空间
  main/en/desktop/*.json          主进程 desktop 16 个子命名空间
  manifest.json                   版本、asar 哈希、bundle 哈希、补丁锚点
translations/zh-CN/               译文（与英文源同构，可只提供部分键）
  renderer/*.json
  main/desktop/*.json
scripts/
  cli/main.mjs                    factory-l10n CLI 主命令
  extract.mjs                     解包 + AST 还原英文资源树
  verify.mjs                      译文结构/占位符/复数/标签/覆盖率校验
  build.mjs                      生成 zh 资源分块 + 注入补丁 + 重打包 asar
  install.mjs                     备份、替换、写完整性哈希、ad-hoc 重签名
  restore.mjs                     从备份还原原始应用
  doctor.mjs                      版本/签名/fuse/补丁状态巡检
  poc.mjs                         隔离副本启动 + CDP 读界面 + 截图
bin/factory-l10n.mjs              可执行 CLI 入口
docs/
  architecture.md                 Factory 语言机制与补丁点
  constraints.md                  签名、完整性、自动更新的边界
  platforms.md                    macOS / Windows / Linux 布局与实测状态
  workflow.md                     翻译与发版工作流
  glossary.md                     术语表与翻译红线
  poc-report.md                   本次 PoC 的验证记录与哈希基线
work/                             临时解包、构建、备份、PoC（gitignore）
dist/                             构建产物：app.asar、资源分块副本、unpacked、补丁清单（gitignore）
```

## 工作原理（简版）

1. **英文源**：Factory 的 i18next 资源被 Vite 内联进 bundle，仓库用 acorn 做 AST 解析，按标识符递归还原成 JSON，不依赖正则扫描。
2. **补丁点**：渲染层补「支持语言列表 + 动态资源加载器 + zh 资源分块」；主进程补「supported 白名单 + desktop 资源表」。
3. **完整性**：`ElectronAsarIntegrity.hash` 是 **asar 头部 JSON 字符串**的 SHA-256，不是整文件哈希；安装器会重新计算并写入。
4. **签名**：原应用由 Factory 签名，改动后必须重签。仓库保留原始 entitlements、剔除 ad-hoc 无法持有的团队/keychain 项后重签。
5. **回滚**：安装前用 APFS clone 完整备份原应用；`npm run restore` 直接还原原始签名版本。

## 当前进度

- [x] 英文源抽取（21,007 条，0 解析失败）
- [x] 补丁链路（渲染层语言开关 + 资源分块 + 主进程白名单/资源表）
- [x] 完整性哈希与 ad-hoc 重签名
- [x] PoC：隔离副本启动、`html lang=zh-CN`、界面中文截图
- [x] PoC 翻译：`common`、`components.layout` 可见子集、主进程 desktop 全部
- [ ] 全量翻译（settings / sessions / chat / automations / lessons 等）

## 边界与声明

- 仅供本机个人使用，**不要分发**修改后的应用包。
- 修改后的应用使用 ad-hoc 签名；Factory 的 Squirrel 自动更新可能失败或被覆盖，升级前请先 `npm run restore`。
- 译文缺失的键会自动回退英文，因此可以按命名空间分批翻译。
- 硬编码在代码里、未走 i18next 的字符串不在补丁范围内。