#!/usr/bin/env node
import path from 'node:path';
import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { appInfo, parseArgs, resolveAppPath, sha256File, sha256Text } from './lib/app.mjs';
import { extractAsar, hasChinesePack, listUnpackedFiles, readAsarHeader } from './lib/asar.mjs';
import {
  countStrings,
  extractMainCatalog,
  extractRendererCatalog,
  locateMainBundle,
  locateRendererEntry,
  sortDeep,
  writeJson,
  writeNamespaceFiles,
} from './lib/catalog.mjs';

const args = parseArgs();
const appPath = resolveAppPath(args);
const app = appInfo(appPath);
const releaseId = `${app.version}-${app.build}`;
const pristineDir = path.resolve('work/pristine', releaseId);
const pristineAsar = path.join(pristineDir, 'app.asar');

let sourceAsar = app.asarPath;
if (hasChinesePack(app.asarPath)) {
  if (!existsSync(pristineAsar)) {
    console.error('当前安装的是已打补丁的应用，且仓库没有原始 asar 快照。');
    console.error('请先运行 npm run restore 还原原始应用，再重新 extract。');
    process.exit(1);
  }
  console.log(`检测到补丁版应用，改用原始 asar 快照：${pristineAsar}`);
  sourceAsar = pristineAsar;
}

const asarSha256 = await sha256File(sourceAsar);
const catalogDir = path.resolve(args.out || path.join('catalog', releaseId));
const extractDir = path.resolve('work/extract', `${releaseId}-${asarSha256.slice(0, 8)}`);

console.log(`应用：${appPath}`);
console.log(`版本：${app.version} (build ${app.build})`);
console.log(`源 app.asar：${sourceAsar}`);
console.log(`SHA-256：${asarSha256}`);
console.log(`解包到：${extractDir}`);

await extractAsar(sourceAsar, extractDir);
if (sourceAsar === app.asarPath) {
  mkdirSync(pristineDir, { recursive: true });
  cpSync(app.asarPath, pristineAsar, { force: true, clone: true });
  const unpacked = `${app.asarPath}.unpacked`;
  if (existsSync(unpacked)) {
    cpSync(unpacked, `${pristineAsar}.unpacked`, {
      recursive: true,
      force: true,
      clone: true,
      verbatimSymlinks: true,
    });
  }
}
const header = readAsarHeader(sourceAsar);
const topLevelEntries = Object.keys(header.files ?? {}).length;
const unpackedFiles = listUnpackedFiles(header);

const entryPath = locateRendererEntry(extractDir);
const mainBundlePath = locateMainBundle(extractDir);
console.log(`渲染层入口：${path.relative(extractDir, entryPath)}`);
console.log(`主进程入口：${path.relative(extractDir, mainBundlePath)}`);

const renderer = extractRendererCatalog(entryPath);
const main = extractMainCatalog(mainBundlePath);

const allErrors = [...renderer.resolverErrors, ...main.resolverErrors];
if (allErrors.length) {
  const errorFile = path.resolve('work/extract-errors.json');
  writeFileSync(errorFile, `${JSON.stringify(allErrors, null, 2)}\n`, 'utf8');
  console.error(`\n提取失败：有 ${allErrors.length} 个无法静态解析的节点，详情见 ${errorFile}`);
  for (const error of allErrors.slice(0, 10)) {
    console.error(`- ${error.path} [${error.type}] ${error.detail}\n  ${error.snippet}`);
  }
  if (!args['allow-errors']) process.exit(1);
}

const rendererDir = path.join(catalogDir, 'renderer/en');
const mainDir = path.join(catalogDir, 'main/en/desktop');
const rendererManifest = writeNamespaceFiles(rendererDir, sortDeep(renderer.namespaces));
const mainManifest = writeNamespaceFiles(mainDir, sortDeep(main.desktop));

const rendererStrings = countStrings(renderer.namespaces);
const mainStrings = countStrings(main.desktop);
const manifest = sortDeep({
  app: {
    version: app.version,
    build: app.build,
    bundleId: app.bundleId,
    asarSha256,
    integrityHash: app.integrityHash,
    unpackedFiles,
  },
  generatedAt: new Date().toISOString(),
  renderer: {
    entry: path.relative(extractDir, entryPath),
    entrySha256: sha256Text(renderer.source),
    namespaces: rendererManifest,
    strings: rendererStrings,
    anchors: renderer.anchors,
  },
  main: {
    bundle: path.relative(extractDir, mainBundlePath),
    bundleSha256: sha256Text(main.source),
    desktop: mainManifest,
    strings: mainStrings,
    anchors: main.anchors,
  },
  totals: {
    namespaces: Object.keys(rendererManifest).length + Object.keys(mainManifest).length,
    rendererStrings,
    mainStrings,
    strings: rendererStrings + mainStrings,
    asarTopLevelEntries: topLevelEntries,
    unpackedFiles: unpackedFiles.length,
  },
});
writeJson(path.join(catalogDir, 'manifest.json'), manifest);

console.log('\n命名空间（渲染层）：');
for (const [name, info] of Object.entries(rendererManifest)) {
  console.log(`  ${name.padEnd(24)} ${String(info.strings).padStart(6)} 条`);
}
console.log('\n命名空间（主进程 desktop）：');
for (const [name, info] of Object.entries(mainManifest)) {
  console.log(`  ${name.padEnd(24)} ${String(info.strings).padStart(6)} 条`);
}
console.log(`\n合计：${rendererStrings + mainStrings} 条字符串（渲染层 ${rendererStrings}，主进程 ${mainStrings}）`);
console.log(`语言列表变量：${renderer.anchors.languageListVariable} = ${renderer.anchors.languageListValues.join(', ')}`);
console.log(`资源加载器条目：${renderer.anchors.loaderEntries.map((entry) => entry.language).join(', ')}`);
console.log(`\n英文源已写入：${catalogDir}`);