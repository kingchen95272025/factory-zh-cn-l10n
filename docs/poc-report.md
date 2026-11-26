# PoC 验证报告：Factory 1.20.0 (build 17041)

- 验证时间：2026-11-26
- 应用版本：Factory 1.20.0 (build 17041)
- 原始 app.asar SHA-256：`320c8a948e4806104d6e97dfbc253810fbfe2fef73c663fe7e233d50dfc93493`
- 补丁 app.asar SHA-256：`be6b81c4a290202566afd3c388bc8e6de5947589402f14b1c5d87389f1e37d43`
- asar 头部完整性哈希：`4b9d5c09f7e966bd0ebc4425cc35f6bc83fc7bf288be676ed1564377ef17909d`
- 渲染层资源分块：`resources-zhCN-55033086.js`
- 译文覆盖：647 / 9,176（已建译文的命名空间）
  - `renderer/common`：365 / 365（100%）
  - `renderer/components`：142 / 7,886（`layout` 可见子集 + 主界面问候/输入/项目选择等）
  - `renderer/sessions`：2 / 787（输入框占位与 Local 标签）
  - `main/desktop`：138 / 138（16 个子命名空间全部完成，复数归并后）

## 验证方式

`npm run poc` 执行以下闭环，全程不触碰 `/Applications/Factory.app`：

1. APFS clone 一份应用到 `work/poc/1.20.0-17041/Factory-patched.app`；
2. 注入 `dist/1.20.0-17041/app.asar`，更新 `Info.plist` 头部哈希；
3. 剔除 ad-hoc 不可持有的 entitlements 后重签名；
4. 使用独立 `--user-data-dir` 启动副本，附加自动选择的空闲 `--remote-debugging-port`；
5. 通过 CDP 读取 `document.body.innerText` 与 `<html lang>`，期望文案取自 `dist/` 中的资源分块副本；
6. 断言界面已稳定（非加载页），静态校验主进程 desktop 资源，并在辅助功能权限可用时读取原生菜单栏；
7. 用 `Page.captureScreenshot` 截图。

## 结果

| 检查项 | 结果 |
|---|---|
| 应用启动 | 通过（补丁 asar + ad-hoc 签名 + 完整性校验） |
| `codesign --verify --deep --strict` | 通过 |
| `Info.plist` 完整性哈希 | 与 asar 头部一致 |
| `<html lang>` | `zh-CN` |
| 界面中文字符 | 41（随启动页面不同会有波动） |
| 命中构建产物文案 | 23 条（新建会话 / 任务控制 / 自动化 / 代码审查 / 搜索 / 选择项目 / 拖放以添加附件…） |
| 主进程中文资源静态校验 | 通过（1,305 个中文字符） |
| 原生菜单栏运行态 | `Apple / Factory / 文件 / Edit / 视图 / Window / 帮助`（中英混合，Edit/Window 为系统角色） |
| 主界面截图 | `work/poc/1.20.0-17041/screenshot.png` |
| 进程清理 | 通过（副本与 droid 守护进程均已退出） |

## 附加验证：安装与还原

在独立副本 `work/test-restore/Factory.app` 上执行：

1. `npm run install:patch -- --app work/test-restore/Factory.app`：安装成功，ad-hoc 签名校验通过；
2. 人为执行 `codesign --remove-signature` 制造坏签名，再次安装：被识别为「asar 一致但签名无效」，自动重新安装并修复；
3. `npm run restore -- --app work/test-restore/Factory.app`：还原成功，签名 Team ID 回到 Factory 官方 `SW6TL4V6Q5`；
4. 移走应用目录后再次 `restore`：仍能从版本匹配的备份完成救援。

### CLI 闭环

在 `work/cli-test/Factory.app` 上执行：

```bash
node bin/factory-l10n.mjs install --app work/cli-test/Factory.app --pack dist/1.20.0-17041 --state-dir work/cli-test/state --yes
node bin/factory-l10n.mjs status   --app work/cli-test/Factory.app --state-dir work/cli-test/state
node bin/factory-l10n.mjs check-update --app work/cli-test/Factory.app --state-dir work/cli-test/state
node bin/factory-l10n.mjs uninstall --app work/cli-test/Factory.app --state-dir work/cli-test/state --yes
```

结果：安装/状态/更新检查（`up-to-date`）/卸载全部通过，卸载后签名与完整性校验恢复原版。

### 非 .app 布局

在 `work/cli-dir/Factory/resources/app.asar`（模拟 Windows/Linux 的目录布局）上执行同样的 CLI 闭环：备份为 asar + unpacked + metadata，安装不写 plist、不签名，卸载后 asar 哈希恢复原值。Windows/Linux 的真实安装尚未在本机验证，见 [platforms.md](./platforms.md)。

## 结论

- 渲染层语言白名单、资源加载器、资源分块三处补丁均生效；
- 主进程 supported 白名单与 desktop 资源表补丁生效（设置语言不再报 `Unsupported app locale`；原生菜单已验证为中文，Edit/Window 为系统角色）；
- asar 头部完整性哈希与 ad-hoc 重签名链路可用；
- 安装 → 使用 → 还原的闭环可用；
- 部分翻译可正常回退英文，具备按命名空间分批交付的条件。

## 已知限制

- 当前 PoC 只覆盖 `common`、`components.layout` 可见子集、少量 `sessions` 与主进程全部文案；设置页、聊天区、自动化等仍为英文。
- 修改后的应用使用 ad-hoc 签名，Squirrel 自动更新需先 `npm run restore`。
- 截图包含本机测试账号昵称，仅保留在 `work/`（gitignore），未纳入版本库。