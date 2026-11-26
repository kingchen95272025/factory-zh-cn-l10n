# 约束：完整性校验、签名与自动更新

这份文档记录「为什么必须重打包、重签名」，以及本地补丁的能力边界。任何绕过这些约束的尝试都会让应用无法启动。

## 1. Electron fuses（Factory 1.20.0）

```text
Fuse Version: v1
  RunAsNode is Disabled
  EnableCookieEncryption is Enabled
  EnableNodeOptionsEnvironmentVariable is Disabled
  EnableNodeCliInspectArguments is Disabled
  EnableEmbeddedAsarIntegrityValidation is Enabled   ← 关键
  OnlyLoadAppFromAsar is Enabled                     ← 关键
  LoadBrowserProcessSpecificV8Snapshot is Disabled
  GrantFileProtocolExtraPrivileges is Enabled
  WasmTrapHandlers is Enabled
```

影响：

- **不能**用 `NODE_OPTIONS`、`--inspect` 或外部 preload 注入语言包。
- **不能**把语言资源放在 `app.asar` 旁边的目录让 Electron 直接读取。
- 唯一可行路径是修改 `app.asar` 本身，并让完整性校验与签名同时成立。

## 2. asar 完整性哈希

`Info.plist` 中：

```xml
<key>ElectronAsarIntegrity</key>
<dict>
  <key>Resources/app.asar</key>
  <dict>
    <key>algorithm</key><string>SHA256</string>
    <key>hash</key><string>…</string>
  </dict>
</dict>
```

`hash` 的计算对象是 **asar 头部 JSON 字符串**（文件偏移 8 开始的 `headerSize` 字节），不是整个 asar 文件。

验证方式：

```bash
node -e '
const asar = require("@electron/asar");
const crypto = require("crypto");
console.log(crypto.createHash("sha256")
  .update(asar.getRawHeader("app.asar").headerString, "utf8")
  .digest("hex"));
'
```

仓库中的 `npm run doctor` 会自动比对当前 asar 头部哈希与 `Info.plist`。不一致时应用会在启动阶段直接 FATAL。

## 3. 代码签名

原应用：

- Team ID：`SW6TL4V6Q5`
- Hardened Runtime：开启
- Entitlements：`com.apple.application-identifier`、`com.apple.developer.team-identifier`、`com.apple.security.cs.*`、`com.apple.security.device.audio-input`、网络权限、`keychain-access-groups`

本仓库没有 Factory 的私钥，因此只能 **ad-hoc 重签名**：

```bash
codesign --force --deep --sign - \
  --options runtime \
  --entitlements <entitlements-adhoc.plist> \
  /Applications/Factory.app
```

`install.mjs` 会：

1. 从原应用导出 entitlements；
2. 剔除 ad-hoc 无法合法持有的项：
   - `com.apple.application-identifier`
   - `com.apple.developer.team-identifier`
   - `keychain-access-groups`
3. 用剩余权限重签，并执行 `codesign --verify --deep --strict`。

### 已知影响

- WebAuthn / Passkey、依赖 Keychain access group 的功能可能降级或触发授权提示。
- 首次启动可能出现系统弹窗；这与补丁本身无关，是签名身份变化导致。
- 若应用带 quarantine 属性（例如重新下载），Gatekeeper 可能拒绝启动；本地原位修改一般不受影响。

## 4. Squirrel 自动更新

Factory 使用 Squirrel.Mac。修改后的应用会带来两个后果：

1. **更新会覆盖补丁**：官方更新直接把 `app.asar` 换回官方版本，语言包失效。
2. **更新校验可能失败**：Squirrel 会校验签名，ad-hoc 签名与原 Team ID 不一致，可能拒绝安装更新。

因此：

- 升级前执行 `npm run restore`，把应用还原为原始签名版本。
- 升级完成后重新 `npm run extract` → `npm run verify` → `npm run build` → `npm run install:patch`。
- `npm run doctor` 会检测版本漂移与补丁状态。

## 5. 备份与回滚

安装器在替换任何文件之前，会先用 APFS clone 完整复制一份原应用到 staging 目录，校验副本 asar 哈希并读取原始 entitlements，最后以原子 rename 落盘：

```text
work/backups/<version>-<build>-<asar sha8>/
  Factory.app/            ← 原始应用（含原始签名）
  entitlements.plist      ← 原始 entitlements
  entitlements-adhoc.plist
  metadata.json
```

安全约束：

- 备份复用前会校验 `metadata.sourceAsarSha256` 与备份内 asar 的实际哈希；损坏的备份会被拒绝，而不是当作原始应用。
- 安装的「替换 asar / 替换 unpacked / 写完整性哈希 / 重签名 / 校验签名」在同一个事务内；任一步失败会自动从备份回滚。
- 若当前 asar 已与补丁一致但签名或完整性哈希损坏，再次安装会识别并修复，而不是误报“已安装”。
- 还原只选择与当前应用版本号、build 号匹配的备份；替换前后都会校验签名，失败会把旧应用换回来。
- 即使应用目录已缺失，`restore` 仍可用显式 `--backup` 或最新备份救援。

还原：

```bash
npm run restore -- --quit
```

`restore.mjs` 直接复制回备份应用，**保留原始 `_CodeSignature`**，因此还原后的签名与 Factory 官方一致，无需重新签名。

## 6. 安全与合规边界

- 本工程用于**本机个人使用**，不应分发修改后的应用包。
- 不绕过许可证、不修改鉴权逻辑、不注入网络请求；只添加语言资源与语言白名单。
- 修改第三方闭源应用可能违反其服务条款，请自行评估。
- 仓库不包含 Factory 的源代码或官方翻译资源，只包含从本机安装包静态提取的英文键值，用于本地化开发。

## 7. 失败模式速查

| 现象 | 原因 | 处理 |
|---|---|---|
| 启动即 FATAL「Integrity check failed」 | `Info.plist` 头部哈希与 asar 不匹配 | 重新 `build` + `install`，不要手改 asar |
| 启动后闪退 / 签名无效 | 未重签或签名损坏 | 重新 `install`，或 `restore` |
| 语言仍是英文 | 语言白名单未打补丁 / 资源分块未加载 | 检查 `patch-manifest.json` 的 `languages` 与 `chunk` |
| 切换语言报「Unsupported app locale」 | 主进程 `Sv` 白名单未含中文 | 重新构建，确认 `main.supportedList` 补丁 |
| 部分界面英文 | 该命名空间尚未翻译 | 补齐译文后重新 `build` |
| 应用更新后中文消失 | Squirrel 覆盖了 asar | 直接重新 `extract` → `build` → `install:patch`；`restore` 只适用于回退到**同版本**官方包，升级后通常没有新版本备份 |