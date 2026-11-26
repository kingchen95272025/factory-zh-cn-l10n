import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import {
  appInfo,
  assertAppBundle,
  readInfoPlist,
  run,
  sha256File,
} from './app.mjs';
import { asarIntegrityHash, hasChinesePack } from './asar.mjs';

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
  const candidates = execFileSync('/bin/ls', ['-1t', root], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .map((name) => path.join(root, name))
    .filter((dir) => existsSync(path.join(dir, 'patch-manifest.json')));
  if (!candidates.length) throw new Error('dist 下没有可用的补丁，请先运行 npm run build');
  return candidates[0];
}

export function backupApp(appPath, backupRoot) {
  const info = appInfo(appPath);
  const sourceSha = execFileSync('/usr/bin/shasum', ['-a', '256', info.asarPath], {
    encoding: 'utf8',
  })
    .trim()
    .split(/\s+/)[0];
  const backupDir = path.join(backupRoot, `${info.version}-${info.build}-${sourceSha.slice(0, 8)}`);
  const backupApp = path.join(backupDir, 'Factory.app');
  if (existsSync(backupApp)) {
    return { backupDir, backupApp, created: false, sourceSha };
  }
  mkdirSync(backupDir, { recursive: true });
  console.log(`备份原始应用 → ${backupApp}`);
  cpSync(appPath, backupApp, { recursive: true, clone: true, verbatimSymlinks: true });
  const entitlements = readEntitlementsSafe(appPath);
  if (entitlements) {
    writeFileSync(path.join(backupDir, 'entitlements.plist'), entitlements, 'utf8');
  }
  writeFileSync(
    path.join(backupDir, 'metadata.json'),
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
  const setCommand = `Set :ElectronAsarIntegrity:Resources/app.asar:hash ${hash}`;
  try {
    execFileSync('/usr/libexec/PlistBuddy', ['-c', setCommand, plistPath], {
      encoding: 'utf8',
    });
  } catch {
    execFileSync(
      '/usr/libexec/PlistBuddy',
      [
        '-c',
        'Add :ElectronAsarIntegrity dict',
        '-c',
        'Add :ElectronAsarIntegrity:Resources/app.asar dict',
        '-c',
        `Add :ElectronAsarIntegrity:Resources/app.asar:hash string ${hash}`,
        '-c',
        'Add :ElectronAsarIntegrity:Resources/app.asar:algorithm string SHA256',
        plistPath,
      ],
      { encoding: 'utf8' },
    );
  }
  const plist = readInfoPlist(plistPath);
  const actual = plist.ElectronAsarIntegrity?.['Resources/app.asar']?.hash;
  if (actual !== hash) {
    throw new Error(`完整性哈希写入失败：期望 ${hash}，实际 ${actual}`);
  }
}

export function signApp(appPath, entitlementsPath, options = {}) {
  const args = ['--force', '--deep', '--sign', '-', '--options', 'runtime'];
  if (entitlementsPath && existsSync(entitlementsPath)) {
    args.push('--entitlements', entitlementsPath);
  }
  args.push(appPath);
  try {
    execFileSync('/usr/bin/codesign', args, { encoding: 'utf8' });
    return { signed: true, usedEntitlements: Boolean(entitlementsPath) };
  } catch (error) {
    if (entitlementsPath) {
      console.warn(`带 entitlements 签名失败，降级为无 entitlements 签名：${error.message}`);
      execFileSync(
        '/usr/bin/codesign',
        ['--force', '--deep', '--sign', '-', '--options', 'runtime', appPath],
        { encoding: 'utf8' },
      );
      return { signed: true, usedEntitlements: false };
    }
    throw error;
  }
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
    const metadataPath = path.join(backupDir, 'metadata.json');
    const backupApp = path.join(backupDir, 'Factory.app');
    if (!existsSync(metadataPath) || !existsSync(backupApp)) continue;
    try {
      const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
      if (metadata.sourceAsarSha256 === sourceSha) {
        return { backupDir, backupApp, created: false, sourceSha };
      }
    } catch {
      // 忽略损坏的备份元数据
    }
  }
  return null;
}

export function applyPatchToApp({ appPath, distDir, backupRoot, sign = true, force = false }) {
  const info = appInfo(appPath);
  const dist = loadPatchManifest(distDir);
  const distAsar = path.join(distDir, 'app.asar');
  if (!existsSync(distAsar)) throw new Error(`补丁 asar 不存在：${distAsar}`);

  const currentSha = execFileSync('/usr/bin/shasum', ['-a', '256', info.asarPath], {
    encoding: 'utf8',
  })
    .trim()
    .split(/\s+/)[0];

  if (currentSha === dist.app.outputAsarSha256) {
    return { alreadyInstalled: true, backup: null, info };
  }

  const alreadyPatched = hasChinesePack(info.asarPath);
  if (!alreadyPatched && currentSha !== dist.app.sourceAsarSha256 && !force) {
    throw new Error(
      `app.asar 与补丁来源不匹配（当前 ${currentSha.slice(0, 12)}… / 补丁基于 ${dist.app.sourceAsarSha256.slice(
        0,
        12,
      )}…）。请重新 extract + build，或使用 --force`,
    );
  }
  if (info.version !== dist.app.version || info.build !== dist.app.build) {
    if (!force) {
      throw new Error(
        `应用版本 ${info.version} (${info.build}) 与补丁版本 ${dist.app.version} (${dist.app.build}) 不一致，请重新构建或使用 --force`,
      );
    }
  }

  let backup;
  if (alreadyPatched) {
    backup = findOriginalBackup(backupRoot, dist.app.sourceAsarSha256);
    if (!backup) {
      throw new Error(
        '当前应用已经是补丁版，但找不到对应的原始备份。请先 npm run restore，再重新安装。',
      );
    }
    console.log(`检测到补丁版应用，复用原始备份：${backup.backupDir}`);
  } else {
    backup = backupApp(appPath, backupRoot);
  }
  const integrityHash = dist.app.outputHeaderSha256 ?? asarIntegrityHash(distAsar);
  const actualDistHash = asarIntegrityHash(distAsar);
  if (actualDistHash !== integrityHash) {
    throw new Error(`补丁 asar 头部哈希与清单不一致：${actualDistHash} vs ${integrityHash}`);
  }
  console.log(`替换 app.asar → ${info.asarPath}`);
  cpSync(distAsar, info.asarPath, { force: true });

  const distUnpacked = `${distAsar}.unpacked`;
  const targetUnpacked = `${info.asarPath}.unpacked`;
  if (existsSync(distUnpacked)) {
    rmSync(targetUnpacked, { recursive: true, force: true });
    cpSync(distUnpacked, targetUnpacked, { recursive: true, clone: true, verbatimSymlinks: true });
  }

  updateIntegrityHash(info.plistPath, integrityHash);

  let signing = { signed: false };
  if (sign) {
    const entitlementsPath = path.join(backup.backupDir, 'entitlements.plist');
    let effectiveEntitlements = entitlementsPath;
    if (existsSync(entitlementsPath)) {
      const sanitized = sanitizeEntitlements(readFileSync(entitlementsPath, 'utf8'));
      const sanitizedPath = path.join(backup.backupDir, 'entitlements-adhoc.plist');
      writeFileSync(sanitizedPath, sanitized, 'utf8');
      effectiveEntitlements = sanitizedPath;
    }
    console.log('重新签名（ad-hoc + hardened runtime）');
    signing = signApp(appPath, effectiveEntitlements);
  }

  const signature = verifySignature(appPath);
  if (!signature.valid) {
    throw new Error(`签名校验失败：${signature.detail}`);
  }

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