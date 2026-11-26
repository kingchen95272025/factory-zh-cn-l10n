#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { appInfo, parseArgs, resolveAppPath, sha256File, sha256Text } from './lib/app.mjs';
import { extractAsar, packAsar, asarIntegrityHash } from './lib/asar.mjs';
import { patchMain, patchRenderer } from './lib/patch.mjs';
import {
  loadManifest,
  loadSourceCatalog,
  loadTranslations,
  resolveRelease,
} from './lib/release.mjs';
import {
  countStrings,
  formatPercent,
  normalizeChinesePlurals,
  summarize,
  validateNamespace,
} from './lib/text.mjs';

const args = parseArgs();
const releaseId = resolveRelease(args.release);
const lang = String(args.lang || 'zh-CN');
const appPath = resolveAppPath(args);
const app = appInfo(appPath);
const manifest = loadManifest(releaseId);
const currentAsarSha256 = await sha256File(app.asarPath);
const pristineAsar = path.resolve('work/pristine', releaseId, 'app.asar');

let sourceAsar = app.asarPath;
let asarSha256 = currentAsarSha256;
if (currentAsarSha256 !== manifest.app.asarSha256) {
  if (existsSync(pristineAsar)) {
    const pristineSha256 = await sha256File(pristineAsar);
    if (pristineSha256 === manifest.app.asarSha256) {
      console.log('当前安装的是补丁版应用，改用原始 asar 快照构建');
      sourceAsar = pristineAsar;
      asarSha256 = pristineSha256;
    }
  }
}

if (asarSha256 !== manifest.app.asarSha256 && !args['allow-mismatch']) {
  console.error('应用版本与英文目录不匹配：');
  console.error(`  当前 app.asar：${currentAsarSha256}`);
  console.error(`  目录记录：    ${manifest.app.asarSha256}`);
  console.error(`请先运行 npm run extract 生成 ${app.version}-${app.build} 的英文目录；`);
  console.error('或使用 --allow-mismatch 强制构建（不推荐）。');
  process.exit(1);
}

const source = loadSourceCatalog(releaseId);
const translations = loadTranslations(lang);
const notes = [];
const validationErrors = [];
const results = [];

function normalizeGroup(sourceGroup, translationGroup, label) {
  const output = {};
  for (const [name, sourceObject] of Object.entries(sourceGroup)) {
    const target = translationGroup[name];
    if (!target) continue;
    const normalized = normalizeChinesePlurals(target, `${label}/${name}`, notes);
    if (countStrings(normalized) === 0) continue;
    const result = validateNamespace(sourceObject, normalized, `${label}/${name}`);
    results.push(result);
    validationErrors.push(...result.errors);
    output[name] = normalized;
  }
  return output;
}

const rendererResources = normalizeGroup(source.renderer, translations.renderer, 'renderer');
const mainDesktop = normalizeGroup(source.main, translations.main, 'main');

if (validationErrors.length) {
  console.error(`翻译校验失败（${validationErrors.length} 个错误），构建已中止：`);
  for (const error of validationErrors.slice(0, 30)) console.error(`  ✗ ${error}`);
  if (validationErrors.length > 30) console.error(`  ... 其余 ${validationErrors.length - 30} 条`);
  process.exit(1);
}

const totals = summarize(results);
if (totals.translated === 0) {
  console.error(`未找到任何 ${lang} 译文，请先在 translations/${lang} 下创建文件`);
  process.exit(1);
}

const buildRoot = path.resolve('work/build', releaseId);
const extractDir = path.join(buildRoot, 'app');
const distDir = path.resolve('dist', releaseId);
rmSync(buildRoot, { recursive: true, force: true });
rmSync(distDir, { recursive: true, force: true });
mkdirSync(buildRoot, { recursive: true });
mkdirSync(distDir, { recursive: true });

console.log(`构建 Factory ${manifest.app.version} (build ${manifest.app.build}) 的 ${lang} 语言包`);
console.log(`解包 app.asar → ${extractDir}`);
await extractAsar(sourceAsar, extractDir);

const entryPath = path.join(extractDir, manifest.renderer.entry);
const mainBundlePath = path.join(extractDir, manifest.main.bundle);
if (!existsSync(entryPath)) throw new Error(`渲染层入口不存在：${entryPath}`);
if (!existsSync(mainBundlePath)) throw new Error(`主进程 bundle 不存在：${mainBundlePath}`);

const entrySource = readFileSync(entryPath, 'utf8');
const mainSource = readFileSync(mainBundlePath, 'utf8');
if (sha256Text(entrySource) !== manifest.renderer.entrySha256) {
  throw new Error('渲染层入口哈希与英文目录不一致，请重新运行 npm run extract');
}
if (sha256Text(mainSource) !== manifest.main.bundleSha256) {
  throw new Error('主进程 bundle 哈希与英文目录不一致，请重新运行 npm run extract');
}

const rendererPatch = patchRenderer(entrySource, rendererResources);
const mainPatch = patchMain(mainSource, mainDesktop);

writeFileSync(entryPath, rendererPatch.source, 'utf8');
writeFileSync(mainBundlePath, mainPatch.source, 'utf8');
const chunkPath = path.join(
  path.dirname(entryPath),
  rendererPatch.chunk.filename,
);
writeFileSync(chunkPath, rendererPatch.chunk.content, 'utf8');

const outputAsar = path.join(distDir, 'app.asar');
console.log('重新打包 app.asar（保留 node_modules/keytar 为 unpacked）');
await packAsar(extractDir, outputAsar, { unpackDir: 'node_modules/keytar' });
const outputSha256 = await sha256File(outputAsar);
const outputHeaderSha256 = asarIntegrityHash(outputAsar);

const patchManifest = {
  generator: 'factory-zh-cn-l10n',
  releaseId,
  language: lang,
  app: {
    version: manifest.app.version,
    build: manifest.app.build,
    bundleId: manifest.app.bundleId,
    sourceAsarSha256: manifest.app.asarSha256,
    outputAsarSha256: outputSha256,
    outputHeaderSha256,
  },
  renderer: {
    entry: manifest.renderer.entry,
    chunk: rendererPatch.chunk.filename,
    chunkSha256: sha256Text(rendererPatch.chunk.content),
    chunkBytes: Buffer.byteLength(rendererPatch.chunk.content),
    alreadyPatched: rendererPatch.alreadyPatched,
    enumName: rendererPatch.enumName,
    languages: rendererPatch.languageList,
  },
  main: {
    bundle: manifest.main.bundle,
    alreadyPatched: mainPatch.alreadyPatched,
    enumName: mainPatch.enumName,
    supportedList: mainPatch.supportedList,
    languages: mainPatch.languages,
  },
  coverage: {
    total: totals.total,
    translated: totals.translated,
    missing: totals.missing,
    percent: Number((totals.coverage * 100).toFixed(2)),
  },
  namespaces: results.map((result) => ({
    namespace: result.namespace,
    total: result.total,
    translated: result.translated,
    coverage: Number((result.coverage * 100).toFixed(2)),
  })),
  notes,
  generatedAt: new Date().toISOString(),
};
writeFileSync(path.join(distDir, 'patch-manifest.json'), `${JSON.stringify(patchManifest, null, 2)}\n`);

console.log(`\n渲染层：${Object.keys(rendererResources).length} 个命名空间，资源分块 ${rendererPatch.chunk.filename}`);
console.log(`主进程：${Object.keys(mainDesktop).length} 个 desktop 子命名空间`);
console.log(`覆盖率：${formatPercent(totals.coverage)}（${totals.translated}/${totals.total}）`);
console.log(`输出 asar：${outputAsar}`);
console.log(`输出 SHA-256：${outputSha256}`);
if (existsSync(`${outputAsar}.unpacked`)) {
  console.log(`unpacked 目录：${outputAsar}.unpacked`);
}
for (const note of notes.slice(0, 10)) console.log(`  - ${note}`);
console.log('\n构建完成。接下来：npm run doctor → npm run poc 或 npm run install:patch');