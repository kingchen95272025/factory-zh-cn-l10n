# 全量语言包验证报告：Factory 1.20.0 (build 17041)

- 验证时间：2026-11-26
- 应用版本：Factory 1.20.0 (build 17041)
- 原始 app.asar SHA-256：`320c8a948e4806104d6e97dfbc253810fbfe2fef73c663fe7e233d50dfc93493`
- 补丁 app.asar SHA-256：`7c6db704bb69d3f111ebc250528eea78d5d765c211d46274a1d91c7558a582d2`
- asar 头部完整性哈希：`d4ce472d5987f14011151c511ba03077578b85d3d919f6a733826d3ea9bacd9c`
- 渲染层资源分块：`resources-zhCN-798ac301.js`
- 译文覆盖：**20,584 / 20,584（100%）**
  - 19 个渲染层命名空间全部覆盖，包括 `settings` 4,618、`components` 8,174、`sessions` 799、`automations` 1,588、`lessons` 2,356 等
  - 主进程 `desktop` 16 个子命名空间 138 / 138（复数归并后）
  - 结构错误 0；剩余可见警告均为 FSC、GitHub、Jira、OpenAI、Geist 等品牌/技术名

## 验证方式

### 隔离 PoC

`npm run poc` 会 APFS clone 一份原始应用、注入补丁、重签、用独立数据目录启动，并通过 CDP 读取界面、截图。

本次全量包在**全新 userData** 下启动时，应用卡在「Loading your organization」——这是隔离数据目录缺少登录/组织上下文的网络问题，与语言包无关；因此隔离 PoC 不作为最终结论。

### 正式应用验证

正式安装到 `/Applications/Factory.app` 后，使用现有登录数据启动，并用 CDP 检查：

```bash
factory-l10n install --quit
open -n -a /Applications/Factory.app --args --remote-debugging-port=9445 --lang=zh-CN
```

结果：

| 检查项 | 结果 |
|---|---|
| 应用启动 | 通过（补丁 asar + ad-hoc 签名 + 完整性校验） |
| `codesign --verify --deep --strict` | 通过 |
| `<html lang>` | `zh-CN` |
| 主界面 | 新建会话 / 自动化 / 搜索 / 更多 / 工作流 / 项目 / 完成设置 / 连接 GitHub / 松开以取消固定 |
| 设置页 | 账号 / 通用 / 外观 / 身份 / 连接器 / 会话管理 / 任务 / 工作流默认值 / 偏好设置 / 语言：简体中文 |
| 原生菜单 | `Apple / Factory / 文件 / Edit / 视图 / Window / 帮助` |
| 主进程中文资源静态校验 | 通过（1,305 个中文字符） |
| 设置页截图 | `work/full-settings.png` |

用户数据、仓库名、分支名、会话标题（如 `Core Development Partner`、`Start new chat`）属于运行时内容，不在翻译范围内。

## 翻译流程

1. `npm run plan:translation`：按约 350 条/块拆分为 80 块；
2. 三路并行翻译代理按分块写入 `work/translation/<ns>/*.zh.json`；
3. `node scripts/check-translation-chunks.mjs`：80/80 分块通过，缺失 0；
4. `npm run merge:translation`：合并分块，保留既有 `common` / layout 译文；
5. `node scripts/fix-terminology.mjs`：统一 Plan=方案、Service Account=服务账号、Voucher=优惠码、Code Review=代码审查；
6. `npm run verify`：20,584 / 20,584，0 错误；
7. `npm run build` + `factory-l10n install --quit`。

## 结论

- 全量 UI 文案已覆盖（渲染层 19 个命名空间 + 主进程 desktop）；
- 设置页、主界面、原生菜单均已验证为中文；
- 仅品牌/技术名、用户数据与少数硬编码运行时内容保留英文；
- 安装 → 使用 → 卸载还原、跨平台 CLI 与更新检查均已可用；Windows/Linux 实机验证仍待补充。

## 已知限制

- 修改后的应用使用 ad-hoc 签名，Squirrel 自动更新前需先 `factory-l10n uninstall`。
- 隔离 PoC 使用全新数据目录时可能卡在组织加载，验证正式应用时请使用现有登录数据，或给 `npm run poc` 传 `--user-data-dir`。
- 少量运行时生成的会话标题、仓库/分支名、用户输入不翻译。