#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { appInfo, isAppRunning, parseArgs, resolveAppPath, sha256File } from './lib/app.mjs';
import { asarIntegrityHash } from './lib/asar.mjs';
import { loadManifest, listReleases, loadSourceCatalog, loadTranslations, resolveRelease } from './lib/release.mjs';
import {
  formatPercent,
  normalizeChinesePlurals,
  summarize,
  validateNamespace,
} from './lib/text.mjs';

const args = parseArgs();
const appPath = resolveAppPath(args);

function safeRun(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { encoding: 'utf8' });
  return `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
}

const info = appInfo(appPath);
const asarSha = await sha256File(info.asarPath);
const headerHash = asarIntegrityHash(info.asarPath);
const signature = safeRun('/usr/bin/codesign', ['-dv', appPath]);
const team = signature.match(/TeamIdentifier=([^\n]+)/)?.[1] ?? '未知';
const fusesBinary = path.resolve('node_modules/.bin/electron-fuses');
const fuses = existsSync(fusesBinary)
  ? safeRun(fusesBinary, ['read', '--app', appPath])
  : '未安装 @electron/fuses';

let releaseId = null;
let releaseWarning = null;
try {
  releaseId = resolveRelease(args.release);
} catch (error) {
  releaseWarning = error.message;
}

let coverage = null;
if (releaseId) {
  const source = loadSourceCatalog(releaseId);
  const translations = loadTranslations(String(args.lang || 'zh-CN'));
  const results = [];
  for (const [kind, sourceGroup, translationGroup] of [
    ['renderer', source.renderer, translations.renderer],
    ['main', source.main, translations.main],
  ]) {
    for (const [name, sourceObject] of Object.entries(sourceGroup)) {
      const target = translationGroup[name];
      if (!target) continue;
      const normalized = normalizeChinesePlurals(target, name, []);
      results.push(validateNamespace(sourceObject, normalized, `${kind}/${name}`));
    }
  }
  coverage = summarize(results);
}

let distDirs = [];
const distRoot = path.resolve('dist');
if (existsSync(distRoot)) {
  distDirs = readdirSync(distRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(path.join(distRoot, entry.name, 'patch-manifest.json')))
    .map((entry) => {
      const dir = path.join(distRoot, entry.name);
      return { dir, manifest: JSON.parse(readFileSync(path.join(dir, 'patch-manifest.json'), 'utf8')) };
    })
    .sort((left, right) => right.manifest.generatedAt.localeCompare(left.manifest.generatedAt));
}

const installedStatePath = path.resolve('work/installed-state.json');
const installedState = existsSync(installedStatePath)
  ? JSON.parse(readFileSync(installedStatePath, 'utf8'))
  : null;

let verdict = '原版（未打补丁）';
if (distDirs.length && asarSha === distDirs[0].manifest.app.outputAsarSha256) {
  verdict = `已安装补丁 ${distDirs[0].manifest.releaseId}（${distDirs[0].manifest.language}）`;
} else if (distDirs.length && asarSha !== distDirs[0].manifest.app.sourceAsarSha256) {
  verdict = '未知 asar（既非原版也非当前补丁，可能已升级或被其他工具修改）';
}

console.log(`Factory 巡检`);
console.log('═'.repeat(60));
console.log(`应用路径：${appPath}`);
console.log(`版本：${info.version} (build ${info.build})`);
console.log(`Bundle ID：${info.bundleId}`);
console.log(`app.asar SHA-256：${asarSha}`);
console.log(`asar 头部完整性哈希：${headerHash}`);
console.log(`Info.plist 完整性哈希：${info.integrityHash ?? '无'}`);
console.log(`完整性校验：${info.integrityHash === headerHash ? '通过' : '不一致（应用可能无法启动）'}`);
console.log(`运行状态：${isAppRunning(appPath) ? '运行中' : '未运行'}`);
console.log(`签名 Team ID：${team}`);
console.log(`当前判定：${verdict}`);
if (installedState) {
  console.log(
    `最近安装记录：${installedState.installedAt} → ${installedState.appPath}${
      installedState.appPath === appPath ? '' : '（非当前应用，可能是 PoC 副本）'
    }`,
  );
}
console.log(`\nElectron Fuses：\n${fuses}`);

if (releaseId) {
  const manifest = loadManifest(releaseId);
  const patchedVerdict = verdict.startsWith('已安装补丁');
  const compareHash = patchedVerdict ? distDirs[0]?.manifest.app.sourceAsarSha256 : asarSha;
  console.log(`\n英文目录：${releaseId}（${manifest.totals.strings} 条字符串）`);
  console.log(
    `英文目录与${patchedVerdict ? '补丁来源' : '当前应用'}一致：${
      manifest.app.asarSha256 === compareHash ? '是' : '否（需要重新 extract）'
    }`,
  );
  if (coverage) {
    console.log(
      `已建译文命名空间覆盖率：${formatPercent(coverage.coverage)}（${coverage.translated}/${coverage.total}）`,
    );
  }
} else {
  console.log(`\n英文目录：${releaseWarning}`);
}

if (distDirs.length) {
  const latest = distDirs[0];
  console.log(`\n最新补丁：${latest.manifest.releaseId}`);
  console.log(`  语言：${latest.manifest.language}`);
  console.log(`  覆盖率：${latest.manifest.coverage.percent}%`);
  console.log(`  生成时间：${latest.manifest.generatedAt}`);
  console.log(`  输出 asar：${latest.manifest.app.outputAsarSha256}`);
} else {
  console.log('\n尚未构建任何补丁（dist 为空）');
}

const releases = listReleases();
if (releases.length > 1) {
  console.log(`\n历史英文目录：${releases.join(', ')}`);
}

console.log('\n提醒：');
console.log('- Factory 自动更新后，app.asar 会被替换回官方版本，补丁随之失效；升级前先 restore。');
console.log('- 修改后的应用使用 ad-hoc 签名，Squirrel 更新校验可能失败，这是本地补丁的已知代价。');
if (!args.quiet) {
  const warnings = [];
  if (releaseId && verdict === '原版（未打补丁）' && loadManifest(releaseId).app.asarSha256 !== asarSha) {
    warnings.push('应用 app.asar 与英文目录版本不一致，建议重新运行 npm run extract。');
  }
  if (warnings.length) {
    console.log('\n警告：');
    for (const warning of warnings) console.log(`  ! ${warning}`);
  }
}