# 跨平台支持

`factory-l10n` 在 macOS / Windows / Linux 上使用同一套命令，差别在于应用布局、完整性校验与签名方式。

## 1. 应用布局

| 平台 | 典型路径 | 布局 | 完整性/签名 |
|---|---|---|---|
| macOS | `/Applications/Factory.app` | `Contents/Resources/app.asar` | `Info.plist` 的 `ElectronAsarIntegrity` + codesign |
| Windows（Squirrel） | `%LOCALAPPDATA%\Factory\app-<version>` | `resources\app.asar` | 无 plist 完整性；不打乱 EXE 的 Authenticode |
| Windows（安装包） | `%LOCALAPPDATA%\Programs\Factory`、`Program Files\Factory` | `resources\app.asar` | 同上 |
| Linux（deb/rpm 解包） | `/opt/Factory`、`/usr/lib/factory`、`/usr/share/factory` | `resources/app.asar` | 无签名 |
| Linux（AppImage） | 挂载的 squashfs | 只读挂载 | 不支持原位补丁，需先解包 AppImage 再重新打包 |

自动发现会遍历上述路径；检测到多个安装时用 `--app` 指定。

## 2. 平台分支

### macOS

- 修改 `app.asar` 后必须同步 `Info.plist` 的 `ElectronAsarIntegrity`（asar 头部 JSON 的 SHA-256），然后 ad-hoc 重签。
- 备份整个 `Factory.app`，还原时整包换回，签名恢复为 Factory 官方。
- 已在 Factory 1.20.0 (build 17041) 上实测。

### Windows

- 只替换 `resources\app.asar` 与 `resources\app.asar.unpacked`，不修改 EXE/DLL，因此不影响 Authenticode。
- 备份为 `app.asar` + `app.asar.unpacked` + `metadata.json`，体积远小于整包备份。
- Squirrel 升级会在新目录 `app-<version>` 安装，补丁不会继承；升级后需重新 `pack` + `install`。
- 代码路径已实现；**尚未在真实 Windows 安装上实测**，首次使用请先 `factory-l10n status` 确认路径与版本。

### Linux

- 支持 deb/rpm 等解包安装（`resources/app.asar` 可写）。
- AppImage 是只读 squashfs，不能原位替换；需要 `--appimage-extract` 后重新打包，当前版本不自动处理。
- 代码路径已实现；**尚未在真实 Linux 安装上实测**。

## 3. 状态与备份目录

| 平台 | 默认目录 |
|---|---|
| macOS | `~/Library/Application Support/factory-l10n` |
| Windows | `%LOCALAPPDATA%\factory-l10n` |
| Linux | `$XDG_STATE_HOME/factory-l10n` 或 `~/.local/state/factory-l10n` |

结构：

```text
factory-l10n/
  installed/<platform>-<app hash>.json   ← 每个应用的安装记录
  backups/<version>-<build>-<sha8>/      ← 原始应用/asar 备份
```

可用 `--state-dir` 或环境变量 `FACTORY_L10N_STATE` 覆盖。

## 4. 语言包与平台

`patch-manifest.json` 记录构建平台与源 asar 哈希：

```json
{
  "app": {
    "version": "1.20.0",
    "build": "17041",
    "platform": "darwin",
    "sourceAsarSha256": "…",
    "outputAsarSha256": "…"
  }
}
```

`factory-l10n install` 会校验：

1. 语言包平台与当前应用平台一致；
2. 语言包针对的 Factory 版本一致；
3. 构建版本（build）一致（两边都有时）；
4. 语言包的源 asar 哈希与目标应用当前 asar 一致（已安装补丁时用备份中的原始哈希校验）。

任一不满足都会拒绝安装，并提示在当前平台/版本上重新 `factory-l10n pack`。

## 5. 更新检查

```bash
factory-l10n check-update
factory-l10n check-update --remote https://example.com/factory-l10n/manifest.json --json
```

本地检查：

- 当前应用是否已安装语言包；
- 本地 `dist/` 是否有与已安装版本不同的语言包；
- Factory 版本是否已变化（语言包需要重建）；
- macOS 上额外检查完整性哈希与签名。

远程清单格式（可选）：

```json
{
  "schema": 1,
  "packs": [
    {
      "platform": "darwin",
      "factoryVersion": "1.20.0",
      "build": "17041",
      "language": "zh-CN",
      "url": "https://example.com/factory-l10n/1.20.0-17041/app.asar",
      "sha256": "…",
      "headerSha256": "…",
      "releasedAt": "2026-11-26T00:00:00Z"
    }
  ]
}
```

退出码：`0` 已是最新，`10` 可更新/未安装，`20` 语言包与应用不兼容，`1` 错误。

## 6. 实测状态

| 平台 | 状态 |
|---|---|
| macOS 14 (Apple Silicon) | ✅ 完整实测：安装、状态、更新检查、卸载、坏签名修复、目录缺失救援 |
| Windows | ⚠️ 路径与安装分支已实现，未在真实安装上验证 |
| Linux | ⚠️ 路径与安装分支已实现，未在真实安装上验证；AppImage 不支持 |

跨平台分支复用同一套构建产物格式与校验逻辑；在 Windows/Linux 上首次使用时，建议先在副本上执行 `factory-l10n install --app <副本路径>` 验证，再操作正式安装。