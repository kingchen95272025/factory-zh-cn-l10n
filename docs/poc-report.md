# PoC 验证报告：Factory 1.20.0 (build 17041)

- 验证时间：2026-11-26
- 应用版本：Factory 1.20.0 (build 17041)
- 原始 app.asar SHA-256：`320c8a948e4806104d6e97dfbc253810fbfe2fef73c663fe7e233d50dfc93493`
- 补丁 app.asar SHA-256：`8296a477c8139fd4e8b4dc2af1e4441169c43b07edcea2a778cab3306aa7d9d8`
- asar 头部完整性哈希：`49f86fee1f0cfde379acdbfd3f351c473b86a3e2623a942a7bc2d4842985e20f`
- 渲染层资源分块：`resources-zhCN-cc2f6020.js`
- 译文覆盖：638 / 8389（已建译文的命名空间）
  - `renderer/common`：365 / 365（100%）
  - `renderer/components`：135 / 7886（仅 `layout` 可见子集）
  - `main/desktop`：142 / 142（16 个子命名空间全部完成）

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
| 界面中文字符 | 17 |
| 命中已翻译文案 | 17 条（新建会话 / 任务控制 / 自动化 / 代码审查 / 搜索…） |
| 主界面截图 | `work/poc/1.20.0-17041/screenshot.png` |
| 进程清理 | 通过（副本与 droid 守护进程均已退出） |

## 结论

- 渲染层语言白名单、资源加载器、资源分块三处补丁均生效；
- 主进程 supported 白名单与 desktop 资源表补丁生效（设置语言不再报 `Unsupported app locale`）；
- asar 头部完整性哈希与 ad-hoc 重签名链路可用；
- 部分翻译可正常回退英文，具备按命名空间分批交付的条件。

## 已知限制

- 当前 PoC 只覆盖 `common`、`components.layout` 可见子集与主进程全部文案；主界面中央区、设置页等仍为英文。
- 修改后的应用使用 ad-hoc 签名，Squirrel 自动更新需先 `npm run restore`。
- 截图包含本机测试账号昵称，仅保留在 `work/`（gitignore），未纳入版本库。