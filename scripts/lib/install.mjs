import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import {
  appInfo,
  assertAppBundle,
  readInfoPlist,
  sha256File,
} from './app.mjs';
import { asarIntegrityHash, hasChinesePack } from './asar.mjs';

function sha256Sync(filePath) {
  return execFileSync('/usr/bin/shasum', ['-a', '256', filePath], { encoding: 'utf8' })
    .trim()
    .split(/\s+/)[0];
}

function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

export function loadPatchManifest(distDir) {
  const manifestPath = path.join(distDir, 'patch-manifest.json');
  if (!existsSync(manifestPath)) throw new Error(`缺少补丁清单：${manifestPath}`);
  return JSON.parse(readFileSync(manifestPath, 'utf8'));
}

export function resolveDist(explicit) {
  if (explicit) {
    const dir = path.resolve(explicit);
    if (!existsSync(path.join(dir, 'patch-manifest.json'))) {
      throw new Error(`不是有效的补丁目录：${dir}`);
    }
    return dir;
  }
  const root = path.resolve('dist');
  if (!existsSync(root)) throw new Error('dist 目录不存在，请先运行 npm run build');
  const candidates = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name))
    .filter((dir) => existsSync(path.join(dir, 'patch-manifest.json')))
    .map((dir) => ({ dir, manifest: loadPatchManifest(dir) }))
    .sort((left, right) => right.manifest.generatedAt.localeCompare(left.manifest.generatedAt));
  if (!candidates.length) throw new Error('dist 下没有可用的补丁，请先运行 npm run build');
  return candidates[0].dir;
}

export function backupApp(appPath, backupRoot) {
  const info = appInfo(appPath);
  const sourceSha = sha256Sync(info.asarPath);
  const backupDir = path.join(backupRoot, `${info.version}-${info.build}-${sourceSha.slice(0, 8)}`);
  const backupApp = path.join(backupDir, 'Factory.app');

  if (existsSync(backupDir)) {
    const metadata = readJson(path.join(backupDir, 'metadata.json'));
    const backupAsar = path.join(backupApp, 'Contents/Resources/app.asar');
    const backupEntitlements = path.join(backupDir, 'entitlements.plist');
    if (
      metadata?.sourceAsarSha256 === sourceSha &&
      existsSync(backupAsar) &&
      sha256Sync(backupAsar) === sourceSha &&
      existsSync(backupEntitlements)
    ) {
      return { backupDir, backupApp, created: false, sourceSha };
    }
    throw new Error(
      `备份目录已存在但校验失败：${backupDir}\n请手动检查该目录，或使用 --backup-root 指定新的备份位置`,
    );
  }

  const entitlements = readEntitlementsSafe(appPath);
  if (!entitlements) {
    throw new Error('无法读取原应用的 entitlements，已中止（缺少它无法安全重签名）');
  }

  const staging = `${backupDir}.staging-${process.pid}`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(path.dirname(backupDir), { recursive: true });
  mkdirSync(staging, { recursive: true });
  console.log(`备份原始应用 → ${backupApp}`);
  try {
    cpSync(appPath, path.join(staging, 'Factory.app'), {
      recursive: true,
      clone: true,
      verbatimSymlinks: true,
    });
    const copiedAsar = path.join(staging, 'Factory.app/Contents/Resources/app.asar');
    if (!existsSync(copiedAsar) || sha256Sync(copiedAsar) !== sourceSha) {
      throw new Error('备份副本的 app.asar 校验失败');
    }
    writeFileSync(path.join(staging, 'entitlements.plist'), entitlements, 'utf8');
    writeFileSync(
      path.join(staging, 'metadata.json'),
      `${JSON.stringify(
        {
          sourceApp: appPath,
          version: info.version,
          build: info.build,
          bundleId: info.bundleId,
          sourceAsarSha256: sourceSha,
          createdAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    renameSync(staging, backupDir);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  return { backupDir, backupApp, created: true, sourceSha };
}

function readEntitlementsSafe(appPath) {
  try {
    const output = execFileSync('/usr/bin/codesign', ['-d', '--entitlements', ':-', appPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const start = output.indexOf('<?xml');
    return start >= 0 ? output.slice(start) : null;
  } catch (error) {
    const output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
    const start = output.indexOf('<?xml');
    return start >= 0 ? output.slice(start) : null;
  }
}

export function sanitizeEntitlements(xml) {
  return xml
    .replace(
      /<key>com\.apple\.application-identifier<\/key>\s*<string>[^<]*<\/string>/g,
      '',
    )
    .replace(
      /<key>com\.apple\.developer\.team-identifier<\/key>\s*<string>[^<]*<\/string>/g,
      '',
    )
    .replace(/<key>keychain-access-groups<\/key>\s*<array>[\s\S]*?<\/array>/g, '');
}

export function updateIntegrityHash(plistPath, hash) {
  const plistBuddy = (command) =>
    spawnSync('/usr/libexec/PlistBuddy', ['-c', command, plistPath], { encoding: 'utf8' });
  const readHash = () =>
    readInfoPlist(plistPath).ElectronAsarIntegrity?.['Resources/app.asar']?.hash;

  plistBuddy(`Set :ElectronAsarIntegrity:Resources/app.asar:hash ${hash}`);
  if (readHash() !== hash) {
    // 父字典可能不存在、或条目缺失；逐个 Add 并忽略“已存在”，最后再 Set 一次。
    plistBuddy('Add :ElectronAsarIntegrity dict');
    plistBuddy('Add :ElectronAsarIntegrity:Resources dict');
    plistBuddy('Add :ElectronAsarIntegrity:Resources/app.asar dict');
    plistBuddy('Add :ElectronAsarIntegrity:Resources/app.asar:algorithm string SHA256');
    plistBuddy(`Set :ElectronAsarIntegrity:Resources/app.asar:hash ${hash}`);
  }

  const actual = readHash();
  if (actual !== hash) {
    throw new Error(`完整性哈希写入失败：期望 ${hash}，实际 ${actual}`);
  }
}

export function signApp(appPath, entitlementsPath) {
  if (!entitlementsPath || !existsSync(entitlementsPath)) {
    throw new Error('缺少 entitlements 文件，拒绝使用无 entitlements 的降级签名');
  }
  execFileSync(
    '/usr/bin/codesign',
    [
      '--force',
      '--deep',
      '--sign',
      '-',
      '--options',
      'runtime',
      '--entitlements',
      entitlementsPath,
      appPath,
    ],
    { encoding: 'utf8' },
  );
  return { signed: true, usedEntitlements: true };
}

export function verifySignature(appPath) {
  try {
    execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { valid: true };
  } catch (error) {
    return { valid: false, detail: `${error.stdout ?? ''}${error.stderr ?? ''}`.trim() };
  }
}

export function findOriginalBackup(backupRoot, sourceSha) {
  if (!existsSync(backupRoot)) return null;
  for (const entry of readdirSync(backupRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const backupDir = path.join(backupRoot, entry.name);
    const backupApp = path.join(backupDir, 'Factory.app');
    const backupAsar = path.join(backupApp, 'Contents/Resources/app.asar');
    const backupEntitlements = path.join(backupDir, 'entitlements.plist');
    const metadata = readJson(path.join(backupDir, 'metadata.json'));
    if (!metadata || !existsSync(backupAsar) || !existsSync(backupEntitlements)) continue;
    if (metadata.sourceAsarSha256 !== sourceSha) continue;
    if (sha256Sync(backupAsar) !== sourceSha) continue;
    return { backupDir, backupApp, created: false, sourceSha };
  }
  return null;
}

/**
 * 用备份替换目标应用，失败时回滚到替换前的应用。
 * 备份签名在替换前校验，避免用坏备份覆盖唯一可用副本。
 */
export function restoreAppFromBackup(appPath, backupApp) {
  const backupSignature = verifySignature(backupApp);
  if (!backupSignature.valid) {
    throw new Error(`备份应用签名无效，拒绝覆盖：${backupSignature.detail}`);
  }

  const staging = `${appPath}.restoring-${process.pid}`;
  const retired = `${appPath}.retired-${process.pid}`;
  rmSync(staging, { recursive: true, force: true });
  rmSync(retired, { recursive: true, force: true });

  cpSync(backupApp, staging, { recursive: true, clone: true, verbatimSymlinks: true });
  const stagedSignature = verifySignature(staging);
  if (!stagedSignature.valid) {
    rmSync(staging, { recursive: true, force: true });
    throw new Error(`备份副本签名校验失败：${stagedSignature.detail}`);
  }

  const hadCurrentApp = existsSync(appPath);
  if (hadCurrentApp) renameSync(appPath, retired);
  try {
    renameSync(staging, appPath);
    const signature = verifySignature(appPath);
    if (!signature.valid) throw new Error(`替换后签名校验失败：${signature.detail}`);
  } catch (error) {
    rmSync(appPath, { recursive: true, force: true });
    if (hadCurrentApp) {
      try {
        renameSync(retired, appPath);
      } catch {
        // 保留 retired 供人工恢复
      }
    }
    throw error;
  }
  if (hadCurrentApp) rmSync(retired, { recursive: true, force: true });
  return { restored: true };
}

// 兼容旧调用名
export const replaceAppFromBackup = restoreAppFromBackup;

export function applyPatchToApp({
  appPath,
  distDir,
  backupRoot,
  sign = true,
  force = false,
}) {
  const info = appInfo(appPath);
  const dist = loadPatchManifest(distDir);
  const distAsar = path.join(distDir, 'app.asar');
  if (!existsSync(distAsar)) throw new Error(`补丁 asar 不存在：${distAsar}`);

  const currentSha = sha256Sync(info.asarPath);

  if (currentSha === dist.app.outputAsarSha256) {
    const headerOk = info.integrityHash === asarIntegrityHash(info.asarPath);
    const signatureOk = verifySignature(appPath).valid;
    if (headerOk && signatureOk) {
      return { alreadyInstalled: true, backup: null, info };
    }
    console.warn('当前 asar 与补丁一致，但完整性哈希或签名无效，将重新安装以修复');
  }

  const alreadyPatched = hasChinesePack(info.asarPath);
  if (!alreadyPatched && currentSha !== dist.app.sourceAsarSha256) {
    throw new Error(
      `app.asar 与补丁来源不匹配（当前 ${currentSha.slice(0, 12)}… / 补丁基于 ${dist.app.sourceAsarSha256.slice(
        0,
        12,
      )}…）。请重新 extract + build`,
    );
  }
  if ((info.version !== dist.app.version || info.build !== dist.app.build) && !force) {
    throw new Error(
      `应用版本 ${info.version} (${info.build}) 与补丁版本 ${dist.app.version} (${dist.app.build}) 不一致，请重新构建`,
    );
  }

  let backup;
  if (alreadyPatched) {
    backup = findOriginalBackup(backupRoot, dist.app.sourceAsarSha256);
    if (!backup) {
      throw new Error(
        '当前应用已经是补丁版，但找不到有效的原始备份。请先 npm run restore，再重新安装。',
      );
    }
    console.log(`检测到补丁版应用，复用原始备份：${backup.backupDir}`);
  } else {
    backup = backupApp(appPath, backupRoot);
  }

  const integrityHash = dist.app.outputHeaderSha256 ?? asarIntegrityHash(distAsar);
  if (asarIntegrityHash(distAsar) !== integrityHash) {
    throw new Error('补丁 asar 头部哈希与清单不一致');
  }

  const expectedUnpacked = dist.app.unpackedFiles ?? [];
  const distUnpacked = `${distAsar}.unpacked`;
  if (expectedUnpacked.length && !existsSync(distUnpacked)) {
    throw new Error('补丁清单声明了 unpacked 文件，但 dist 中缺少 app.asar.unpacked');
  }

  let signing = { signed: false };
  let signature = null;
  try {
    console.log(`替换 app.asar → ${info.asarPath}`);
    const stagingAsar = `${info.asarPath}.installing-${process.pid}`;
    cpSync(distAsar, stagingAsar, { force: true });
    renameSync(stagingAsar, info.asarPath);

    const targetUnpacked = `${info.asarPath}.unpacked`;
    if (existsSync(distUnpacked)) {
      const stagingUnpacked = `${targetUnpacked}.installing-${process.pid}`;
      rmSync(stagingUnpacked, { recursive: true, force: true });
      cpSync(distUnpacked, stagingUnpacked, {
        recursive: true,
        clone: true,
        verbatimSymlinks: true,
      });
      rmSync(targetUnpacked, { recursive: true, force: true });
      renameSync(stagingUnpacked, targetUnpacked);
    }
    for (const relativePath of expectedUnpacked) {
      if (!existsSync(path.join(targetUnpacked, relativePath))) {
        throw new Error(`unpacked 文件缺失：${relativePath}`);
      }
    }

    updateIntegrityHash(info.plistPath, integrityHash);

    if (sign) {
      const entitlementsPath = path.join(backup.backupDir, 'entitlements.plist');
      const sanitizedPath = path.join(backup.backupDir, 'entitlements-adhoc.plist');
      const sanitized = sanitizeEntitlements(readFileSync(entitlementsPath, 'utf8'));
      writeFileSync(sanitizedPath, sanitized, 'utf8');
      console.log('重新签名（ad-hoc + hardened runtime）');
      signing = signApp(appPath, sanitizedPath);

      signature = verifySignature(appPath);
      if (!signature.valid) throw new Error(`签名校验失败：${signature.detail}`);
    }
  } catch (error) {
    console.error('安装失败，正在从备份自动恢复原始应用…');
    try {
      restoreAppFromBackup(appPath, backup.backupApp);
      console.error(`已恢复原始应用：${appPath}`);
    } catch (restoreError) {
      console.error(`自动恢复失败，请手动运行 npm run restore：${restoreError.message}`);
    }
    throw error;
  }

  mkdirSync(path.resolve('work'), { recursive: true });
  writeFileSync(
    path.resolve('work/installed-state.json'),
    `${JSON.stringify(
      {
        appPath,
        releaseId: dist.releaseId,
        installedAt: new Date().toISOString(),
        asarSha256: dist.app.outputAsarSha256,
        integrityHash,
        version: dist.app.version,
        build: dist.app.build,
        backupDir: backup.backupDir,
        signing,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  return { alreadyInstalled: false, backup, info, signing, signature };
}

export async function assertPatchMatchesApp(appPath, distDir) {
  const info = appInfo(appPath);
  const dist = loadPatchManifest(distDir);
  const currentSha = await sha256File(info.asarPath);
  return { info, dist, currentSha, matches: currentSha === dist.app.sourceAsarSha256 };
}

export { assertAppBundle };