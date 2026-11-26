import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import {
  appInfo,
  defaultStateRoot,
  discoverApps,
  isAppRunning,
  parseArgs,
  quitApp,
  resolveAppPath,
  sha256File,
  sha256Text,
} from '../lib/app.mjs';
import { asarIntegrityHash, hasChinesePack } from '../lib/asar.mjs';
import {
  applyPatchToApp,
  findOriginalBackup,
  loadBackupRecord,
  loadPatchManifest,
  resolveDist,
  restoreAppFromBackup,
  verifySignature,
} from '../lib/install.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const VERSION = '0.2.0';

const HELP = `factory-l10n ${VERSION} — Factory 桌面应用语言包管理工具

用法：
  factory-l10n <命令> [选项]

命令：
  install       安装当前平台可用的最新语言包（或 --pack 指定）
  uninstall     卸载语言包，还原原始应用（别名：restore）
  status        查看应用、语言包与安装状态
  check-update  检查 Factory 版本与语言包是否有更新
  pack          为当前应用抽取英文源并构建语言包
  list          列出检测到的 Factory 安装与本地语言包
  help          显示帮助

通用选项：
  --app <path>       指定 Factory 应用目录/安装目录（默认自动发现）
  --pack <dir>       指定语言包目录（dist/<release>）
  --state-dir <dir>  状态与备份目录（默认按平台）
  --json             机器可读输出
  --yes              跳过确认
  --quit             应用运行中时尝试退出
  --force            忽略版本不一致（谨慎）
  --remote <url>     check-update 时额外检查远程清单

平台路径：
  macOS    /Applications/Factory.app
  Windows  %LOCALAPPDATA%\\Factory\\app-<version> 或 Program Files\\Factory
  Linux    /opt/Factory、/usr/lib/factory 等
`;

function stateRootFor(args) {
  return path.resolve(args['state-dir'] || process.env.FACTORY_L10N_STATE || defaultStateRoot());
}

function packRoot() {
  return path.join(REPO_ROOT, 'dist');
}

function resolveAppForCommand(args) {
  if (args.app || process.env.FACTORY_APP) return resolveAppPath(args);
  const apps = discoverApps();
  if (!apps.length) {
    throw new Error('未自动找到 Factory 安装目录，请用 --app 指定');
  }
  if (apps.length > 1) {
    throw new Error(`检测到多个 Factory 安装，请用 --app 指定：\n${apps.map((item) => `  - ${item}`).join('\n')}`);
  }
  return apps[0];
}

function stateFileFor(info, stateRoot) {
  const key = sha256Text(`${info.platform}:${info.appPath}`).slice(0, 12);
  return path.join(stateRoot, 'installed', `${info.platform}-${key}.json`);
}

function readInstalledState(stateFile) {
  try {
    return JSON.parse(readFileSync(stateFile, 'utf8'));
  } catch {
    return null;
  }
}

function listPacks() {
  const root = packRoot();
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name))
    .filter((dir) => existsSync(path.join(dir, 'patch-manifest.json')))
    .map((dir) => ({ dir, manifest: loadPatchManifest(dir) }))
    .sort((left, right) => right.manifest.generatedAt.localeCompare(left.manifest.generatedAt));
}

function packPlatform(manifest) {
  return manifest.app.platform ?? 'darwin';
}

function pickPack(args) {
  if (args.pack) {
    const dir = resolveDist(args.pack);
    return { dir, manifest: loadPatchManifest(dir) };
  }
  const packs = listPacks().filter((pack) => packPlatform(pack.manifest) === process.platform);
  if (!packs.length) {
    throw new Error(
      `本地没有 ${process.platform} 平台的语言包。请先运行 factory-l10n pack（需要仓库内依赖），或用 --pack 指定`,
    );
  }
  return packs[0];
}

function ensurePackCompatible(info, pack) {
  if (packPlatform(pack.manifest) !== info.platform) {
    throw new Error(
      `语言包平台 ${packPlatform(pack.manifest)} 与当前应用平台 ${info.platform} 不一致。请在当前平台重新运行 factory-l10n pack`,
    );
  }
  if (pack.manifest.app.version !== info.version) {
    throw new Error(
      `语言包针对 Factory ${pack.manifest.app.version}，当前应用是 ${info.version}。请重新运行 factory-l10n pack`,
    );
  }
  if (
    info.build !== null &&
    pack.manifest.app.build !== null &&
    String(info.build) !== String(pack.manifest.app.build)
  ) {
    throw new Error(
      `语言包针对 build ${pack.manifest.app.build}，当前应用是 build ${info.build}。请重新 pack`,
    );
  }
}

async function confirm(args, question) {
  if (args.yes) return true;
  if (!process.stdin.isTTY) {
    throw new Error('非交互环境请加 --yes 确认');
  }
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await readline.question(`${question} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    readline.close();
  }
}

function ensureStopped(info, args) {
  if (!isAppRunning(info.appPath)) return;
  if (!args.quit) {
    throw new Error('Factory 正在运行。请先退出应用，或加 --quit 让工具尝试退出');
  }
  console.log('正在退出 Factory…');
  quitApp(info.appPath);
  return (async () => {
    for (let index = 0; index < 30; index += 1) {
      if (!isAppRunning(info.appPath)) return;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error('Factory 仍在运行，请手动退出后重试');
  })();
}

function printJson(value) {
  console.log(`${JSON.stringify(value, null, 2)}`);
}

function describeApp(info, state, pack) {
  return {
    appPath: info.appPath,
    platform: info.platform,
    layout: info.layout,
    version: info.version,
    build: info.build,
    asarPath: info.asarPath,
    chinesePackInstalled: hasChinesePack(info.asarPath),
    installed: state
      ? { releaseId: state.releaseId, installedAt: state.installedAt, asarSha256: state.asarSha256 }
      : null,
    latestPack: pack
      ? {
          dir: pack.dir,
          releaseId: pack.manifest.releaseId,
          generatedAt: pack.manifest.generatedAt,
          coverage: pack.manifest.coverage,
        }
      : null,
  };
}

async function commandStatus(args) {
  const info = appInfo(resolveAppForCommand(args));
  const stateRoot = stateRootFor(args);
  const state = readInstalledState(stateFileFor(info, stateRoot));
  const packs = listPacks().filter((pack) => packPlatform(pack.manifest) === info.platform);
  const pack = packs[0] ?? null;
  const result = describeApp(info, state, pack);
  if (args.json) {
    printJson(result);
    return 0;
  }
  console.log(`Factory 语言包状态`);
  console.log(`  应用：${result.appPath}`);
  console.log(`  平台：${result.platform}（布局 ${result.layout}）`);
  console.log(`  版本：${result.version}${result.build ? ` (build ${result.build})` : ''}`);
  console.log(`  中文补丁：${result.chinesePackInstalled ? '已安装' : '未安装'}`);
  if (state) console.log(`  安装记录：${state.installedAt} → ${state.releaseId}`);
  if (pack) {
    console.log(`  最新语言包：${pack.manifest.releaseId}（${pack.manifest.coverage.percent}%，${pack.manifest.generatedAt}）`);
  } else {
    console.log('  最新语言包：无');
  }
  if (info.layout === 'mac') {
    const signature = verifySignature(info.appRoot);
    const integrityOk = info.integrityHash === asarIntegrityHash(info.asarPath);
    console.log(`  完整性：${integrityOk ? '通过' : '不一致'}`);
    console.log(`  签名：${signature.valid ? '通过' : '失败'}`);
  }
  return 0;
}

async function commandInstall(args) {
  const appPath = resolveAppForCommand(args);
  const info = appInfo(appPath);
  const pack = pickPack(args);
  ensurePackCompatible(info, pack);
  const stateRoot = stateRootFor(args);
  const stateFile = stateFileFor(info, stateRoot);
  const backupRoot = path.join(stateRoot, 'backups');

  if (!(await confirm(args, `将向 ${info.appPath} 安装 ${pack.manifest.releaseId} 语言包，继续？`))) {
    console.log('已取消');
    return 1;
  }
  await ensureStopped(info, args);

  const result = applyPatchToApp({
    appPath: info.appPath,
    distDir: pack.dir,
    backupRoot,
    stateFile,
    sign: true,
    force: Boolean(args.force),
  });
  if (result.alreadyInstalled) {
    console.log('已是最新语言包，无需重复安装');
    return 0;
  }
  console.log(`安装完成：${info.appPath}`);
  console.log(`语言包：${pack.manifest.releaseId}（${pack.manifest.coverage.percent}%）`);
  console.log(`原始备份：${result.backup.backupDir}`);
  console.log('提示：Factory 自动更新会覆盖补丁；升级前请先 factory-l10n uninstall');
  return 0;
}

async function commandUninstall(args) {
  const info = appInfo(resolveAppForCommand(args));
  const stateRoot = stateRootFor(args);
  const stateFile = stateFileFor(info, stateRoot);
  const state = readInstalledState(stateFile);

  if (!hasChinesePack(info.asarPath)) {
    console.log('当前应用未检测到中文补丁，无需卸载');
    return 0;
  }

  let backup;
  if (state?.backupDir) {
    backup = loadBackupRecord(state.backupDir);
  } else {
    const backupsDir = path.join(stateRoot, 'backups');
    const candidates = existsSync(backupsDir)
      ? readdirSync(backupsDir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => {
            try {
              return loadBackupRecord(path.join(backupsDir, entry.name));
            } catch {
              return null;
            }
          })
          .filter(Boolean)
          .filter(
            (record) =>
              record.metadata.platform === info.platform &&
              record.metadata.version === info.version,
          )
      : [];
    if (!candidates.length) {
      throw new Error('找不到可用备份，无法卸载。请用 --pack 重新安装后重试，或手动还原官方应用');
    }
    backup = candidates.sort((left, right) =>
      String(right.metadata.createdAt).localeCompare(String(left.metadata.createdAt)),
    )[0];
  }

  if (!(await confirm(args, `将从备份还原 ${info.appPath}，继续？`))) {
    console.log('已取消');
    return 1;
  }
  await ensureStopped(info, args);
  restoreAppFromBackup(info.appPath, backup);
  rmSync(stateFile, { force: true });
  console.log(`卸载完成，已还原原始应用：${info.appPath}`);
  return 0;
}

async function commandCheckUpdate(args) {
  const info = appInfo(resolveAppForCommand(args));
  const stateRoot = stateRootFor(args);
  const state = readInstalledState(stateFileFor(info, stateRoot));
  const packs = listPacks().filter((pack) => packPlatform(pack.manifest) === info.platform);
  const latest = packs[0] ?? null;

  const result = {
    app: { path: info.appPath, platform: info.platform, version: info.version, build: info.build },
    installed: state ? { releaseId: state.releaseId, installedAt: state.installedAt } : null,
    localPack: latest
      ? {
          releaseId: latest.manifest.releaseId,
          generatedAt: latest.manifest.generatedAt,
          coverage: latest.manifest.coverage,
        }
      : null,
    status: 'up-to-date',
    reasons: [],
    remote: null,
  };

  if (!latest) {
    result.status = 'no-pack';
    result.reasons.push('本地没有语言包');
  } else {
    try {
      ensurePackCompatible(info, latest);
    } catch (error) {
      result.status = 'incompatible';
      result.reasons.push(error.message);
    }
    if (!state) {
      if (result.status === 'up-to-date') result.status = 'not-installed';
      result.reasons.push('当前应用未安装语言包');
    } else if (latest.manifest.app.outputAsarSha256 !== state.asarSha256) {
      if (result.status === 'up-to-date') result.status = 'pack-update-available';
      result.reasons.push('存在与已安装版本不同的语言包');
    }
  }

  if (args.remote) {
    try {
      const response = await fetch(String(args.remote));
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const remoteManifest = await response.json();
      const candidates = (remoteManifest.packs ?? []).filter(
        (pack) =>
          pack.platform === info.platform &&
          pack.language === (latest?.manifest.language ?? 'zh-CN'),
      );
      candidates.sort((left, right) =>
        String(right.releasedAt ?? '').localeCompare(String(left.releasedAt ?? '')),
      );
      result.remote = candidates[0] ?? null;
      if (result.remote && state?.installedAt && result.remote.releasedAt > state.installedAt) {
        if (result.status === 'up-to-date') result.status = 'remote-update-available';
        result.reasons.push(`远程有更新：${result.remote.releasedAt}`);
      }
    } catch (error) {
      result.remote = { error: error.message };
      result.reasons.push(`远程检查失败：${error.message}`);
    }
  }

  if (args.json) {
    printJson(result);
  } else {
    console.log(`更新检查`);
    console.log(`  应用：${result.app.path}`);
    console.log(`  版本：${result.app.version}${result.app.build ? ` (build ${result.app.build})` : ''}`);
    console.log(`  本地语言包：${result.localPack ? result.localPack.releaseId : '无'}`);
    console.log(`  已安装：${result.installed ? result.installed.releaseId : '无'}`);
    console.log(`  状态：${result.status}`);
    for (const reason of result.reasons) console.log(`  - ${reason}`);
    if (result.remote?.url) console.log(`  远程：${result.remote.url}`);
  }

  if (result.status === 'incompatible' || result.status === 'no-pack') return 20;
  if (result.status.includes('update-available') || result.status === 'not-installed') return 10;
  return 0;
}

async function commandPack(args) {
  const appPath = resolveAppForCommand(args);
  const extractScript = path.join(REPO_ROOT, 'scripts/extract.mjs');
  const buildScript = path.join(REPO_ROOT, 'scripts/build.mjs');
  const extractFlags = ['--app', appPath];
  const buildFlags = ['--app', appPath];
  if (args.release) buildFlags.push('--release', String(args.release));
  console.log('抽取英文源…');
  const extract = spawnSync(process.execPath, [extractScript, ...extractFlags], {
    stdio: 'inherit',
    cwd: REPO_ROOT,
  });
  if (extract.status !== 0) throw new Error('extract 失败');
  console.log('构建语言包…');
  const build = spawnSync(process.execPath, [buildScript, ...buildFlags], {
    stdio: 'inherit',
    cwd: REPO_ROOT,
  });
  if (build.status !== 0) throw new Error('build 失败');
  return 0;
}

async function commandList(args) {
  const apps = discoverApps().map((appPath) => {
    try {
      const info = appInfo(appPath);
      return {
        appPath,
        platform: info.platform,
        version: info.version,
        build: info.build,
        chinesePackInstalled: hasChinesePack(info.asarPath),
      };
    } catch (error) {
      return { appPath, error: error.message };
    }
  });
  const packs = listPacks().map((pack) => ({
    dir: pack.dir,
    releaseId: pack.manifest.releaseId,
    platform: packPlatform(pack.manifest),
    generatedAt: pack.manifest.generatedAt,
    coverage: pack.manifest.coverage,
  }));
  if (args.json) {
    printJson({ apps, packs });
    return 0;
  }
  console.log('Factory 安装：');
  if (!apps.length) console.log('  未发现');
  for (const app of apps) {
    console.log(
      `  - ${app.appPath}  ${app.version ?? ''}${app.build ? `(${app.build})` : ''}  ${
        app.chinesePackInstalled ? '已装中文补丁' : '原版'
      }`,
    );
  }
  console.log('本地语言包：');
  if (!packs.length) console.log('  无（先运行 factory-l10n pack）');
  for (const pack of packs) {
    console.log(
      `  - ${pack.releaseId}  ${pack.platform}  ${pack.coverage.percent}%  ${pack.generatedAt}\n    ${pack.dir}`,
    );
  }
  return 0;
}

export async function main(argv) {
  const [command = 'help', ...rest] = argv;
  const args = parseArgs(rest);

  switch (command) {
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      return 0;
    case '--version':
    case 'version':
      console.log(VERSION);
      return 0;
    case 'install':
      return commandInstall(args);
    case 'uninstall':
    case 'restore':
      return commandUninstall(args);
    case 'status':
      return commandStatus(args);
    case 'check-update':
    case 'update':
      return commandCheckUpdate(args);
    case 'pack':
      return commandPack(args);
    case 'list':
      return commandList(args);
    default:
      console.error(`未知命令：${command}\n`);
      console.log(HELP);
      return 1;
  }
}