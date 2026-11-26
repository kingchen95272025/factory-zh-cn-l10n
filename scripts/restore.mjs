#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { appInfo, isAppRunning, parseArgs, resolveAppPath, run } from './lib/app.mjs';
import { loadBackupRecord, restoreAppFromBackup, verifySignature } from './lib/install.mjs';

const args = parseArgs();
const appPath = resolveAppPath(args);
let current = null;
try {
  current = appInfo(appPath);
} catch (error) {
  console.warn(`当前应用不可读，将按备份直接恢复：${error.message}`);
}
const backupRoot = path.resolve(args['backup-root'] || 'work/backups');

if (!existsSync(backupRoot)) {
  throw new Error(`没有备份目录：${backupRoot}`);
}

function readMetadata(dir) {
  try {
    return JSON.parse(readFileSync(path.join(dir, 'metadata.json'), 'utf8'));
  } catch {
    return null;
  }
}

let backupDir = args.backup ? path.resolve(args.backup) : null;
if (backupDir) {
  const metadata = readMetadata(backupDir);
  if (
    current &&
    metadata &&
    (metadata.version !== current.version || metadata.build !== current.build)
  ) {
    console.warn(
      `警告：指定的备份版本 ${metadata.version} (${metadata.build}) 与当前应用 ${current.version} (${current.build}) 不一致`,
    );
  }
} else {
  const candidates = readdirSync(backupRoot, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        existsSync(path.join(backupRoot, entry.name, 'Factory.app')),
    )
    .map((entry) => {
      const dir = path.join(backupRoot, entry.name);
      const metadata = readMetadata(dir);
      return { dir, metadata, createdAt: metadata?.createdAt ?? '' };
    })
    .filter(
      (candidate) =>
        !current ||
        (candidate.metadata?.version === current.version &&
          candidate.metadata?.build === current.build),
    )
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));

  if (!candidates.length) {
    const available = readdirSync(backupRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(path.join(backupRoot, entry.name, 'Factory.app')))
      .map((entry) => readMetadata(path.join(backupRoot, entry.name)))
      .filter(Boolean)
      .map((metadata) => `${metadata.version} (${metadata.build})`);
    const targetLabel = current ? `${current.version} (${current.build})` : '可识别的当前应用';
    throw new Error(
      `没有与当前应用 ${targetLabel} 匹配的备份。` +
        `可用备份：${available.join(', ') || '无'}。\n` +
        '如需强制使用其他版本备份，请用 --backup 指定目录。',
    );
  }
  backupDir = candidates[0].dir;
}

const backupDirRecord = loadBackupRecord(backupDir);
const backupApp = backupDirRecord.backupApp;
if (backupApp && !existsSync(backupApp)) throw new Error(`备份应用不存在：${backupApp}`);
if (!backupDirRecord.backupAsar && !backupApp) throw new Error(`备份内容不完整：${backupDir}`);

if (isAppRunning(appPath)) {
  if (args.quit) {
    try {
      run('/usr/bin/osascript', ['-e', 'tell application "Factory" to quit']);
    } catch {
      // 继续等待进程退出
    }
    for (let i = 0; i < 30; i += 1) {
      if (!isAppRunning(appPath)) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (isAppRunning(appPath)) throw new Error('Factory 仍在运行，请手动退出后重试');
  } else {
    throw new Error('Factory 正在运行。请先退出应用，或加 --quit 让脚本尝试退出');
  }
}

console.log(`从备份恢复：${backupDirRecord.backupDir}`);
restoreAppFromBackup(appPath, backupDirRecord);
const signature = verifySignature(appPath);
if (!signature.valid) throw new Error(`恢复后签名校验失败：${signature.detail}`);
rmSync(path.resolve('work/installed-state.json'), { force: true });
console.log(`\n恢复完成：${appPath}`);
console.log('签名校验通过（已还原为原始 Factory 签名）');