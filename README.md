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

# 1. 抽取当前安装版本的英文源
npm run extract

# 2. 校验译文（占位符、键完整性、复数、产品名）
npm run verify
npm test            # 校验器单元测试

# 3. 构建补丁 asar（不改动已安装应用）
npm run build

# 4. 在隔离副本上端到端验证（不碰 /Applications）
npm run poc

# 5. 安装到 /Applications/Factory.app（自动备份 + 重签名）
npm run install:patch -- --quit

# 巡检 / 还原
npm run doctor
npm run restore -- --quit
```

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
  extract.mjs                     解包 + AST 还原英文资源树
  verify.mjs                      译文结构/占位符/复数/覆盖率校验
  build.mjs                      生成 zh 资源分块 + 注入补丁 + 重打包 asar
  install.mjs                     备份、替换、写完整性哈希、ad-hoc 重签名
  restore.mjs                     从备份还原原始应用
  doctor.mjs                      版本/签名/fuse/补丁状态巡检
  poc.mjs                         隔离副本启动 + CDP 读界面 + 截图
docs/
  architecture.md                 Factory 语言机制与补丁点
  constraints.md                  签名、完整性、自动更新的边界
  workflow.md                     翻译与发版工作流
  glossary.md                     术语表与翻译红线
  poc-report.md                   本次 PoC 的验证记录与哈希基线
work/                             临时解包、构建、备份、PoC（gitignore）
dist/                             构建产物：app.asar（内含资源分块）、unpacked、补丁清单（gitignore）
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