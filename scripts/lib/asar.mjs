import { existsSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as asar from '@electron/asar';

export async function extractAsar(asarPath, destDir) {
  rmSync(destDir, { recursive: true, force: true });
  await asar.extractAll(asarPath, destDir);
}

export async function packAsar(srcDir, destPath, options = {}) {
  rmSync(destPath, { force: true });
  await asar.createPackageWithOptions(srcDir, destPath, {
    dot: true,
    ...options,
  });
}

export function readAsarHeader(asarPath) {
  return asar.getRawHeader(asarPath).header;
}

/**
 * Electron 的 ElectronAsarIntegrity 校验的是 asar 头部 JSON 字符串，
 * 而不是整个 asar 文件的哈希。算法固定为 SHA-256。
 */
export function asarIntegrityHash(asarPath) {
  const raw = asar.getRawHeader(asarPath);
  return createHash('sha256').update(raw.headerString, 'utf8').digest('hex');
}

export function hasChinesePack(asarPath) {
  try {
    return asar.listPackage(asarPath).some((entry) => entry.includes('resources-zhCN-'));
  } catch {
    return false;
  }
}

export function listUnpackedFiles(header) {
  const unpacked = [];
  const walk = (node, prefix) => {
    for (const [name, entry] of Object.entries(node.files ?? {})) {
      const fullPath = prefix ? `${prefix}/${name}` : name;
      if (entry.files) {
        walk(entry, fullPath);
      } else if (entry.unpacked) {
        unpacked.push(fullPath);
      }
    }
  };
  walk(header, '');
  return unpacked;
}

export function listFiles(header) {
  const files = [];
  const walk = (node, prefix) => {
    for (const [name, entry] of Object.entries(node.files ?? {})) {
      const fullPath = prefix ? `${prefix}/${name}` : name;
      if (entry.files) {
        walk(entry, fullPath);
      } else {
        files.push({ path: fullPath, size: entry.size ?? 0, unpacked: Boolean(entry.unpacked) });
      }
    }
  };
  walk(header, '');
  return files;
}

export function assertFileExists(filePath, label = filePath) {
  if (!existsSync(filePath)) {
    throw new Error(`缺少文件：${label}`);
  }
  return filePath;
}