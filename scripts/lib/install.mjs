import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function releaseKey(info, sourceSha) {
  return `${info.version}-${info.build ?? 'na'}-${sourceSha.slice(0, 8)}`;
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

function validateBackupRecord(backupDir) {
  const metadata = readJson(path.join(backupDir, 'metadata.json'));
  if (!metadata?.sourceAsarSha256) return null;
  const isMac = metadata.layout === 'mac' || existsSync(path.join(backupDir, 'Factory.app'));
  if (isMac) {
    const backupApp = path.join(backupDir, 'Factory.app');
    const backupAsar = path.join(backupApp, 'Contents/Resources/app.asar');
    const entitlements = path.join(backupDir, 'entitlements.plist');
    if (!existsSync(backupAsar) || !existsSync(entitlements)) return null;
    if (sha256Sync(backupAsar) !== metadata.sourceAsarSha256) return null;
    return { backupDir, backupApp, backupAsar, layout: 'mac', metadata };
  }
  const backupAsar = path.join(backupDir, 'app.asar');
  if (!existsSync(backupAsar)) return null;
  if (sha256Sync(backupAsar) !== metadata.sourceAsarSha256) return null;
  return { backupDir, backupApp: null, backupAsar, layout: 'dir', metadata };
}

export function loadBackupRecord(backupDir) {
  const record = validateBackupRecord(path.resolve(backupDir));
  if (!record) throw new Error(`备份目录校验失败：${backupDir}`);
  return record;
}

export function backupApp(appPath, backupRoot) {
  const info = appInfo(appPath);
  const sourceSha = sha256Sync(info.asarPath);
  const backupDir = path.join(backupRoot, releaseKey(info, sourceSha));

  if (existsSync(backupDir)) {
    const existing = validateBackupRecord(backupDir);
    if (existing && existing.metadata.sourceAsarSha256 === sourceSha) {
      return { ...existing, created: false, sourceSha };
    }
    throw new Error(
      `备份目录已存在但校验失败：${backupDir}\n请手动检查该目录，或使用 --backup-root 指定新的备份位置`,
    );
  }

  const isMac = info.layout === 'mac';
  const entitlements = isMac ? readEntitlementsSafe(info.appRoot) : null;
  if (isMac && !entitlements) {
    throw new Error('无法读取原应用的 entitlements，已中止（缺少它无法安全重签名）');
  }

  const staging = `${backupDir}.staging-${process.pid}`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(path.dirname(backupDir), { recursive: true });
  mkdirSync(staging, { recursive: true });
  console.log(`备份原始应用 → ${backupDir}`);
  try {
    if (isMac) {
      cpSync(info.appRoot, path.join(staging, 'Factory.app'), {
        recursive: true,
        clone: true,
        verbatimSymlinks: true,
      });
      const copiedAsar = path.join(staging, 'Factory.app/Contents/Resources/app.asar');
      if (!existsSync(copiedAsar) || sha256Sync(copiedAsar) !== sourceSha) {
        throw new Error('备份副本的 app.asar 校验失败');
      }
      writeFileSync(path.join(staging, 'entitlements.plist'), entitlements, 'utf8');
    } else {
      cpSync(info.asarPath, path.join(staging, 'app.asar'), { force: true });
      if (sha256Sync(path.join(staging, 'app.asar')) !== sourceSha) {
        throw new Error('备份副本的 app.asar 校验失败');
      }
      const unpacked = `${info.asarPath}.unpacked`;
      if (existsSync(unpacked)) {
        cpSync(unpacked, path.join(staging, 'app.asar.unpacked'), {
          recursive: true,
          clone: true,
          verbatimSymlinks: true,
        });
      }
    }
    writeFileSync(
      path.join(staging, 'metadata.json'),
      `${JSON.stringify(
        {
          sourceApp: appPath,
          platform: info.platform,
          layout: info.layout,
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
  return {
    ...validateBackupRecord(backupDir),
    created: true,
    sourceSha,
  };
}

function readEntitlementsSafe(appPath) {
  if (process.platform !== 'darwin') return null;
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
  if (process.platform !== 'darwin') return;
  const plistBuddy = (command) =>
    spawnSync('/usr/libexec/PlistBuddy', ['-c', command, plistPath], { encoding: 'utf8' });
  const readHash = () =>
    readInfoPlist(plistPath).ElectronAsarIntegrity?.['Resources/app.asar']?.hash;

  plistBuddy(`Set :ElectronAsarIntegrity:Resources/app.asar:hash ${hash}`);
  if (readHash() !== hash) {
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
  if (process.platform !== 'darwin') {
    return { signed: false, usedEntitlements: false, skipped: true };
  }
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
  if (process.platform !== 'darwin') return { valid: true, skipped: true };
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
    const record = validateBackupRecord(path.join(backupRoot, entry.name));
    if (record && record.metadata.sourceAsarSha256 === sourceSha) return record;
  }
  return null;
}

function replaceFileAtomically(sourceFile, targetFile) {
  const staging = `${targetFile}.installing-${process.pid}`;
  cpSync(sourceFile, staging, { force: true });
  renameSync(staging, targetFile);
}

function replaceDirAtomically(sourceDir, targetDir) {
  const staging = `${targetDir}.installing-${process.pid}`;
  rmSync(staging, { recursive: true, force: true });
  cpSync(sourceDir, staging, { recursive: true, clone: true, verbatimSymlinks: true });
  rmSync(targetDir, { recursive: true, force: true });
  renameSync(staging, targetDir);
}

export function restoreAppFromBackup(appPath, backup) {
  const record = typeof backup === 'string' ? loadBackupRecord(path.dirname(backup)) : backup;
  let info = null;
  try {
    info = appInfo(appPath);
  } catch {
    info = null;
  }

  if (record.layout === 'mac') {
    const appRoot = info?.appRoot ?? path.resolve(appPath);
    const backupSignature = verifySignature(record.backupApp);
    if (!backupSignature.valid) {
      throw new Error(`备份应用签名无效，拒绝覆盖：${backupSignature.detail}`);
    }
    const staging = `${appRoot}.restoring-${process.pid}`;
    const retired = `${appRoot}.retired-${process.pid}`;
    rmSync(staging, { recursive: true, force: true });
    rmSync(retired, { recursive: true, force: true });
    cpSync(record.backupApp, staging, { recursive: true, clone: true, verbatimSymlinks: true });
    const stagedSignature = verifySignature(staging);
    if (!stagedSignature.valid) {
      rmSync(staging, { recursive: true, force: true });
      throw new Error(`备份副本签名校验失败：${stagedSignature.detail}`);
    }
    const hadCurrentApp = existsSync(appRoot);
    if (hadCurrentApp) renameSync(appRoot, retired);
    try {
      renameSync(staging, appRoot);
      const signature = verifySignature(appRoot);
      if (!signature.valid) throw new Error(`替换后签名校验失败：${signature.detail}`);
    } catch (error) {
      rmSync(appRoot, { recursive: true, force: true });
      if (hadCurrentApp) {
        try {
          renameSync(retired, appRoot);
        } catch {
          // 保留 retired 供人工恢复
        }
      }
      throw error;
    }
    if (hadCurrentApp) rmSync(retired, { recursive: true, force: true });
    return { restored: true, layout: 'mac' };
  }

  if (!info) {
    throw new Error('当前应用目录不存在，无法按文件级备份恢复；请重新安装 Factory 或手动放置原始应用');
  }
  if (!existsSync(record.backupAsar)) throw new Error(`备份 asar 不存在：${record.backupAsar}`);
  if (sha256Sync(record.backupAsar) !== record.metadata.sourceAsarSha256) {
    throw new Error('备份 asar 哈希校验失败');
  }

  const targetAsar = info.asarPath;
  const retiredAsar = `${targetAsar}.retired-${process.pid}`;
  rmSync(retiredAsar, { force: true });
  if (existsSync(targetAsar)) renameSync(targetAsar, retiredAsar);
  try {
    replaceFileAtomically(record.backupAsar, targetAsar);
    if (sha256Sync(targetAsar) !== record.metadata.sourceAsarSha256) {
      throw new Error('还原后 asar 哈希校验失败');
    }
    const backupUnpacked = path.join(record.backupDir, 'app.asar.unpacked');
    if (existsSync(backupUnpacked)) replaceDirAtomically(backupUnpacked, `${targetAsar}.unpacked`);
  } catch (error) {
    rmSync(targetAsar, { force: true });
    if (existsSync(retiredAsar)) renameSync(retiredAsar, targetAsar);
    throw error;
  }
  rmSync(retiredAsar, { force: true });
  return { restored: true, layout: 'dir' };
}

// 兼容旧调用名
export const replaceAppFromBackup = restoreAppFromBackup;

export function applyPatchToApp({
  appPath,
  distDir,
  backupRoot,
  sign = true,
  force = false,
  stateFile = path.resolve('work/installed-state.json'),
}) {
  const info = appInfo(appPath);
  const dist = loadPatchManifest(distDir);
  const distAsar = path.join(distDir, 'app.asar');
  if (!existsSync(distAsar)) throw new Error(`补丁 asar 不存在：${distAsar}`);

  const currentSha = sha256Sync(info.asarPath);
  const isMac = info.layout === 'mac';
  const packPlatform = dist.app.platform ?? 'darwin';
  if (packPlatform !== info.platform) {
    throw new Error(
      `语言包平台 ${packPlatform} 与当前应用平台 ${info.platform} 不一致，请在当前平台运行 extract + build`,
    );
  }
  const expectedUnpacked = dist.app.unpackedFiles ?? [];
  const distUnpacked = `${distAsar}.unpacked`;
  if (expectedUnpacked.length && !existsSync(distUnpacked)) {
    throw new Error('补丁清单声明了 unpacked 文件，但 dist 中缺少 app.asar.unpacked');
  }
  const unpackedOk = expectedUnpacked.every((relativePath) =>
    existsSync(path.join(`${info.asarPath}.unpacked`, relativePath)),
  );

  if (currentSha === dist.app.outputAsarSha256) {
    const headerOk = isMac ? info.integrityHash === asarIntegrityHash(info.asarPath) : true;
    const signatureOk = verifySignature(info.appRoot).valid;
    if (headerOk && signatureOk && unpackedOk) {
      return { alreadyInstalled: true, backup: null, info };
    }
    console.warn('当前 asar 与补丁一致，但完整性/签名/unpacked 校验未通过，将重新安装以修复');
  }

  const alreadyPatched = hasChinesePack(info.asarPath);
  if (!alreadyPatched && currentSha !== dist.app.sourceAsarSha256) {
    throw new Error(
      `app.asar 与补丁来源不匹配（当前 ${currentSha.slice(0, 12)}… / 补丁基于 ${dist.app.sourceAsarSha256.slice(
        0,
        12,
      )}…）。请在当前平台/版本上运行 extract + build`,
    );
  }
  const versionMismatch = info.version !== dist.app.version;
  const buildMismatch = info.build !== null && dist.app.build !== null && info.build !== dist.app.build;
  if ((versionMismatch || buildMismatch) && !force) {
    throw new Error(
      `应用版本 ${info.version} (${info.build ?? 'n/a'}) 与补丁版本 ${dist.app.version} (${dist.app.build ?? 'n/a'}) 不一致，请重新构建`,
    );
  }

  let backup;
  if (alreadyPatched) {
    backup = findOriginalBackup(backupRoot, dist.app.sourceAsarSha256);
    if (!backup) {
      throw new Error(
        '当前应用已经是补丁版，但找不到有效的原始备份。请先 uninstall/restore，再重新安装。',
      );
    }
    console.log(`检测到补丁版应用，复用原始备份：${backup.backupDir}`);
  } else {
    backup = backupApp(appPath, backupRoot);
  }

  const integrityHash = dist.app.outputHeaderSha256 ?? asarIntegrityHash(distAsar);
  if (isMac && asarIntegrityHash(distAsar) !== integrityHash) {
    throw new Error('补丁 asar 头部哈希与清单不一致');
  }

  let signing = { signed: false };
  let signature = null;
  try {
    console.log(`替换 app.asar → ${info.asarPath}`);
    replaceFileAtomically(distAsar, info.asarPath);

    const targetUnpacked = `${info.asarPath}.unpacked`;
    if (existsSync(distUnpacked)) {
      replaceDirAtomically(distUnpacked, targetUnpacked);
    }
    for (const relativePath of expectedUnpacked) {
      if (!existsSync(path.join(targetUnpacked, relativePath))) {
        throw new Error(`unpacked 文件缺失：${relativePath}`);
      }
    }

    if (isMac) {
      updateIntegrityHash(info.plistPath, integrityHash);
      if (sign) {
        const entitlementsPath = path.join(backup.backupDir, 'entitlements.plist');
        const sanitizedPath = path.join(backup.backupDir, 'entitlements-adhoc.plist');
        const sanitized = sanitizeEntitlements(readFileSync(entitlementsPath, 'utf8'));
        writeFileSync(sanitizedPath, sanitized, 'utf8');
        console.log('重新签名（ad-hoc + hardened runtime）');
        signing = signApp(info.appRoot, sanitizedPath);
        signature = verifySignature(info.appRoot);
        if (!signature.valid) throw new Error(`签名校验失败：${signature.detail}`);
      }
    } else {
      if (sha256Sync(info.asarPath) !== dist.app.outputAsarSha256) {
        throw new Error('安装后 asar 哈希校验失败');
      }
      signature = { valid: true, skipped: true };
    }
  } catch (error) {
    console.error('安装失败，正在从备份自动恢复…');
    try {
      restoreAppFromBackup(info.appRoot, backup);
      console.error(`已恢复原始应用：${info.appRoot}`);
    } catch (restoreError) {
      console.error(`自动恢复失败，请手动运行 uninstall/restore：${restoreError.message}`);
    }
    throw error;
  }

  mkdirSync(path.dirname(stateFile), { recursive: true });
  writeFileSync(
    stateFile,
    `${JSON.stringify(
      {
        appPath: info.appRoot,
        layout: info.layout,
        platform: info.platform,
        releaseId: dist.releaseId,
        installedAt: new Date().toISOString(),
        asarSha256: dist.app.outputAsarSha256,
        integrityHash: isMac ? integrityHash : null,
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