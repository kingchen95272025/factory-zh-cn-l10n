# 工作流：从英文源到可启动的中文界面

## 1. 日常闭环

```bash
# 统一 CLI
node bin/factory-l10n.mjs status
node bin/factory-l10n.mjs pack              # extract + build
node bin/factory-l10n.mjs install --quit
node bin/factory-l10n.mjs check-update
node bin/factory-l10n.mjs uninstall --quit

# 底层脚本
npm run extract
npm run verify
npm run build
npm run poc
npm run install:patch -- --quit
npm run doctor
npm run restore -- --quit
```

顺序原则：**先验证，后安装**。`poc` 永远不会碰 `/Applications`。

## 2. 译文目录

```text
translations/zh-CN/
  renderer/
    common.json          ← 对应 catalog/<ver>/renderer/en/common.json
    settings.json
    sessions.json
    ...
  main/desktop/
    menu.json
    quitGuard.json
    ...
```

- 文件与命名空间一一对应，内部结构与英文源同构。
- **允许只翻译部分键**：缺失的键在运行时回退英文，因此可以按命名空间、按子模块分批交付。
- 键名、层级、类型不得改动；不允许多出英文源不存在的键（`verify` 会报错）。

## 3. 翻译规则（摘要，完整见 [glossary.md](./glossary.md)）

1. `Factory`、`Droid`、`droid`、命令、路径、URL、快捷键原样保留。
2. `{{...}}` 占位符、`$t(...)` 引用、`<tag>...</tag>` 必须逐字对应。
3. 中文只保留 `_other` 复数键；`verify` 与 `build` 会自动归并并给出提示。
4. 界面文案简洁、专业；菜单项优先短词。
5. 中文与英文/数字之间保留一个半角空格。

## 4. 校验输出怎么读

```bash
npm run verify
```

- **覆盖率**：同时输出两个口径：
  - **全量覆盖率**：分母是全部英文源串（复数折叠后约 20,700 条），用于评估整体进度；
  - **已建译文命名空间覆盖率**：分母只统计已创建译文文件的命名空间，用于衡量当前批次完成度。
  `build` 的 `patch-manifest.json` 使用后者。
- **错误**：键不存在、占位符不一致、`$t()` 引用不一致、译文为空、类型错误。构建会直接中止。
- **警告**：译文与英文相同、产品名未保留。这些是提示，不是错误：`Beta`、`Wiki`、`Slack`、`Jira`、`Software Factory`（已约定译作“软件工厂”）等品牌/专名会稳定出现，不要为了消除警告去翻译它们；只需清理真正的漏译。
- **规范化提示**：复数键被归并到 `_other` 时输出。

## 5. 构建产物

```text
dist/<version>-<build>/
  app.asar                   ← 已注入补丁；中文资源分块也在 asar 内部
  app.asar.unpacked/         ← 源 asar 声明的 unpacked 原生模块
  resources-zhCN-<hash>.js   ← 与 asar 内一致的资源分块副本，供检查
  patch-manifest.json        ← 源/输出哈希、补丁点、覆盖率、语言列表、chunk 名、unpacked 列表
```

`patch-manifest.json` 是安装与巡检的唯一依据，不要手工编辑。

## 6. PoC 验证器做了什么

```bash
npm run poc
```

1. APFS clone 一份 `Factory.app` 到 `work/poc/<ver>/Factory-patched.app`；
2. 注入补丁并 ad-hoc 重签；
3. 用独立 `--user-data-dir` 启动副本，自动选择空闲调试端口，并校验 CDP target 属于该副本；
4. 通过 CDP 读取 `document.body.innerText` 与 `<html lang>`；期望文案取自 `dist/` 中与 asar 一致的资源分块副本；
5. 断言：
   - 界面已稳定（不是加载页，`settled=true`）；
   - `html lang === "zh-CN"`；
   - 界面包含中文字符，且命中构建产物中的文案；
   - 主进程 desktop 资源静态校验通过；
6. 辅助功能权限可用时，同时读取原生菜单栏名称，验证主进程菜单是否中文；
7. `Page.captureScreenshot` 截图到 `work/poc/<ver>/screenshot.png`；
8. 注册 SIGINT/SIGTERM 清理，关闭副本与 droid 守护进程，不影响正在运行的原应用与 `/Applications` 数据。

这种方式不依赖 macOS 屏幕录制权限，也不读取用户真实界面。

## 7. 安装与还原

```bash
npm run install:patch -- --quit
```

- 检查应用未运行（`--quit` 会尝试优雅退出）；
- 校验当前 asar 与补丁来源一致；
- APFS clone 备份整个应用；
- 替换 asar 与 unpacked 目录；
- 写入 asar 头部完整性哈希；
- 剔除 ad-hoc 不可持有的 entitlements 后重签；
- 校验签名。

还原：

```bash
npm run restore -- --quit
```

还原后签名回到 Factory 官方版本，可直接接收自动更新。

## 8. Factory 升级后的处理

```bash
npm run restore      # 升级前，还原官方签名（推荐）
# 让 Factory 完成自动更新并重启
npm run extract      # 抽取新版本英文源
npm run verify       # 看缺失键与失效键
# 补齐/修正译文
npm run build
npm run poc
npm run install:patch -- --quit
```

升级后常见变化：

- 新增键：自动回退英文，按覆盖率补齐。
- 键改名/删除：`verify` 报「源目录中不存在该键」，需要删除或改名。
- 压缩变量变化：不影响补丁，锚点按结构重新定位。
- 结构大改（例如 i18n 方案更换）：`extract` 会明确失败，需要更新解析器。

## 9. 建议的全量翻译顺序

按「用户可见频率 × 文案量」排序：

1. `common`、`components.layout`、`components.chat`（主界面与侧栏）
2. `settings`（4618 条，量大但价值高）
3. `sessions`、`inbox`、`automations`
4. `onboarding`、`missions`、`pullRequestReview`
5. `analytics` / `analytics2` / `stats` / `evaluations`
6. `academy` / `lessons`（课程内容，可最后处理）
7. `wiki`、`sharing`、`errors`、`hotkeys`
8. 主进程 `desktop`（已完成 PoC 全量）

建议每个命名空间单独提交，便于审校与回滚。

## 10. 提交约定

- `feat(zh): translate <namespace>`：新增/更新某命名空间译文。
- `fix(zh): ...`：修正术语、占位符或错译。
- `feat(pipeline): ...`：抽取/构建/安装脚本变更。
- 每个提交前跑 `npm run verify`，确保无结构错误。
- 不提交 `work/`、`dist/`、`node_modules/`。