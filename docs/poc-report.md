# PoC 验证报告：Factory 1.20.0 (build 17041)

- 验证时间：2026-11-26
- 应用版本：Factory 1.20.0 (build 17041)
- 原始 app.asar SHA-256：`320c8a948e4806104d6e97dfbc253810fbfe2fef73c663fe7e233d50dfc93493`
- 补丁 app.asar SHA-256：`a7523ac486d8a4695c6666e08ecdbe0d66de3146e69274a1a6df119c19b7eb42`
- asar 头部完整性哈希：`7ea09736f8390a3d6a53342de65103c7c34d13ec955dccc588a1a76e5df68ae9`
- 渲染层资源分块：`resources-zhCN-d9f4ae54.js`
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
4. 使用独立 `--user-data-dir` 启动副本，附加 `--remote-debugging-port=9333`；
5. 通过 CDP 读取 `document.body.innerText` 与 `<html lang>`；
6. 等待语言与界面稳定后断言，并用 `Page.captureScreenshot` 截图。

## 结果

| 检查项 | 结果 |
|---|---|
| 应用启动 | 通过（补丁 asar + ad-hoc 签名 + 完整性校验） |
| `codesign --verify --deep --strict` | 通过 |
| `Info.plist` 完整性哈希 | 与 asar 头部一致 |
| `<html lang>` | `zh-CN` |
| 界面中文字符 | 41 |
| 命中已翻译文案 | 25 条（新建会话 / 任务控制 / 自动化 / 代码审查 / 搜索 / 想让我们做什么？/ 描述任务或提问 / 选择项目 / 拖放以添加附件…） |
| 主界面截图 | `work/poc/1.20.0-17041/screenshot.png` |
| 进程清理 | 通过（副本与 droid 守护进程均已退出） |

## 附加验证：安装与还原

在独立副本 `work/test-restore/Factory.app` 上执行：

1. `npm run install:patch -- --app work/test-restore/Factory.app`：安装成功，ad-hoc 签名校验通过；
2. `npm run restore -- --app work/test-restore/Factory.app`：还原成功，签名 Team ID 回到 Factory 官方 `SW6TL4V6Q5`。

## 结论

- 渲染层语言白名单、资源加载器、资源分块三处补丁均生效；
- 主进程 supported 白名单与 desktop 资源表补丁生效（设置语言不再报 `Unsupported app locale`）；
- asar 头部完整性哈希与 ad-hoc 重签名链路可用；
- 安装 → 使用 → 还原的闭环可用；
- 部分翻译可正常回退英文，具备按命名空间分批交付的条件。

## 已知限制

- 当前 PoC 只覆盖 `common`、`components.layout` 可见子集、少量 `sessions` 与主进程全部文案；设置页、聊天区、自动化等仍为英文。
- 修改后的应用使用 ad-hoc 签名，Squirrel 自动更新需先 `npm run restore`。
- 截图包含本机测试账号昵称，仅保留在 `work/`（gitignore），未纳入版本库。