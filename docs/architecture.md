# 架构：Factory 的本地化机制与补丁点

本文描述 Factory 1.20.0 的语言装载结构，以及本仓库在哪些「承重墙」上开洞。变量名以 1.20.0 的压缩产物为例，**补丁脚本不依赖这些名字**——它按结构特征在 AST 中重新定位。

## 1. 总览

```
┌──────────────────────────────────────────────────────────────┐
│ Factory.app                                                  │
│                                                              │
│  Contents/Info.plist                                         │
│    ElectronAsarIntegrity["Resources/app.asar"].hash          │
│      = SHA256(asar headerString)                             │
│                                                              │
│  Contents/Resources/app.asar                                 │
│  ├── .vite/build/                                            │
│  │   ├── main.js                                             │
│  │   └── initLifecycle-*.js      ← 主进程 i18n（desktop ns） │
│  └── .vite/renderer/main_window/                             │
│      ├── index.html                                          │
│      └── assets/                                             │
│          ├── index-*.js          ← 渲染层 i18n + 英文资源    │
│          └── resources-*.js      ← 各语言资源分块            │
└──────────────────────────────────────────────────────────────┘
```

两层各自维护一份 i18next 实例，互不共享：

| 层 | 命名空间 | 资源位置 | 语言列表 | 语言切换入口 |
|---|---|---|---|---|
| 渲染层 | 19 个（`common`、`settings`、`components`…） | `index-*.js` 内联英文 + `resources-<lang>-*.js` 分块 | `QRt`（8 语言，无中文） | 设置页语言选择 → `setLocale` |
| 主进程 | `desktop`（16 个子命名空间） | `initLifecycle-*.js` 内 `MF` 资源表 | `Sv`（8 语言，无中文） | IPC `i18n:setLocale` |

## 2. 渲染层装载链路

```text
用户/系统语言
   │
   ▼
Def({ saved, candidates, supported: QRt })     ← 语言解析（zh 映射已存在）
   │  zh-CN 若不在 QRt → 回退英文
   ▼
locale = zh-CN
   │
   ▼
buf(locale)
   │
   ├── vuf(i18n, locale)
   │      └── yuf[zh-CN]()  ← 动态 import 资源分块（原版无此条目）
   │
   └── i18n.changeLanguage(locale)
          ├── 更新 <html lang>
          └── 缺失键回退 fallbackLng = en
```

### 补丁点 A：支持语言列表

原版：

```js
QRt = [zg.English, zg.Japanese, zg.Korean, zg.German,
       zg.Spanish, zg.Italian, zg.Polish, zg.French]
```

补丁后追加 `zg.ChineseSimplified`。该列表同时用于：

- `supportedLngs: [...QRt, "en-XA"]`（i18next 初始化）
- 设置页语言选项 `QRt.map(lang => ({ value: lang, label: 显示名 }))`（中文显示名 `简体中文` 原版已存在）

### 补丁点 B：资源加载器

原版 `yuf` 是「语言 → 动态 import」映射：

```js
yuf = {
  [zg.Japanese]: async () => await Sn(() => import("./resources-BRZi4tPD.js"), [], import.meta.url),
  ...
}
```

补丁克隆 Japanese 条目，替换语言键与文件名，插入：

```js
[zg.ChineseSimplified]: async () => await Sn(() => import("./resources-zhCN-<hash>.js"), [], import.meta.url)
```

### 补丁点 C：中文资源分块

新增 `assets/resources-zhCN-<hash>.js`：

```js
const resources = { common: {...}, components: {...}, ... };
export { resources };
```

加载器按命名空间逐个 `addResourceBundle("zh-CN", ns, obj, true, true)`。未提供的命名空间/键会自动回退英文，因此**允许部分翻译**。

## 3. 主进程装载链路

```text
主进程语言偏好
   │
   ▼
F8e() → Def({ saved, candidates: app.getPreferredSystemLanguages(), supported: Sv })
   │  zh-CN 若不在 Sv → 回退英文
   ▼
qF(locale) → i18n.changeLanguage(locale)
   │
   ▼
MF[locale].desktop  ← 原版无 zh-CN 条目
```

### 补丁点 D：主进程 supported 白名单

`Sv` 同时用于：

- 语言偏好解析（`F8e`）
- IPC `i18n:setLocale` 的 zod 校验（`s.stringType().refine(locale => Sv.some(...))`）

不补它，渲染层调用 `setLocale("zh-CN")` 会直接抛 **Unsupported app locale**。

### 补丁点 E：主进程 desktop 资源表

原版 `MF` 含 8 种语言，每项形如 `[Ee.Japanese]: { desktop: uF }`。补丁：

1. 在声明语句前插入 `var __FACTORY_ZH_CN_DESKTOP__ = { menu: {...}, updater: {...}, ... };`
2. 在资源表末尾追加 `[Ee.ChineseSimplified]: { desktop: __FACTORY_ZH_CN_DESKTOP__ }`

覆盖菜单栏、右键菜单、文件对话框、退出确认、更新器、邮箱失败提示等。

## 4. asar 完整性与签名

Electron 的 `EnableEmbeddedAsarIntegrityValidation` 校验的是 **asar 头部 JSON 字符串**：

```text
headerSize = uint32@4
headerString = bytes[8, 8+headerSize]      // JSON
ElectronAsarIntegrity.hash = SHA256(headerString)
```

不是整文件哈希。`scripts/lib/asar.mjs::asarIntegrityHash` 按此实现，`install.mjs` 在替换 asar 后写入 `Info.plist`。签名流程见 [constraints.md](./constraints.md)。

## 5. 版本适配策略

补丁脚本不使用压缩后的变量名（`QRt`、`zg`、`Sv`、`MF` 等会随构建变化），而是：

| 目标 | 结构特征 |
|---|---|
| 渲染层命名空间表 | 含 `"./common.json"` 的 `Object.assign({...})` 调用 |
| 渲染层语言列表 | `supportedLngs: [...X, "en-XA"]` 中的 `X` |
| 渲染层资源加载器 | 计算属性为语言枚举成员、值为含 `import()` 的箭头函数的对象 |
| 主进程资源表 | 计算属性为语言枚举成员、值含 `desktop` 键的对象 |
| 主进程白名单 | `{ saved, candidates, supported }` 调用对象中的 `supported` 标识符 |

每次升级 Factory 后重新 `npm run extract`，`manifest.json` 会记录新的 asar 哈希、bundle 哈希与锚点；`npm run build` 会校验哈希一致后才允许打包。

## 6. 数据流（构建期）

```text
app.asar ──extract──► work/extract/...
                          │
                          ├─ acorn AST ──► catalog/<ver>/renderer/en/*.json
                          │                catalog/<ver>/main/en/desktop/*.json
                          │
translations/zh-CN/*.json ─┤
                          ├─ verify（键/占位符/复数/术语）
                          ├─ normalize（中文复数归并到 _other）
                          ├─ patch（语言列表、加载器、资源表）
                          └─ pack ──► dist/<ver>/app.asar
                                        （内含 resources-zhCN-<hash>.js）
                                        + app.asar.unpacked/
                                        + patch-manifest.json
```

## 7. 跨平台适配

`factory-l10n` 通过「应用布局」而不是平台名来分派安装逻辑：

| 布局 | 识别方式 | 安装动作 |
|---|---|---|
| `mac` | `Contents/Resources/app.asar` | 替换 asar + 更新 plist 完整性哈希 + ad-hoc 重签 |
| `dir` | `resources/app.asar`（Windows Squirrel、Linux deb/rpm） | 替换 asar/unpacked，无 plist/签名 |
| `resources` | 直接传入 resources 目录 | 同上 |
| `asar` | 直接传入 app.asar | 同上 |

- Windows/Linux 的备份是 asar + unpacked + metadata，不复制整包。
- Apple 平台额外做 `ElectronAsarIntegrity` 与 codesign 校验；其他平台只校验 asar 哈希。
- 语言包通过 `patch-manifest.json` 的 `app.platform` 与目标平台匹配，拒绝跨平台安装。
- 详见 [platforms.md](./platforms.md)。

## 8. 未覆盖范围

- 未走 i18next 的硬编码字符串（例如部分第三方组件、日志、错误堆栈）。
- 服务端下发的动态文案（若有）。
- 原生菜单之外的 macOS 系统级文案（由系统语言控制）。
- Factory 升级后新增的键：会回退英文，`npm run verify` 会显示缺失。