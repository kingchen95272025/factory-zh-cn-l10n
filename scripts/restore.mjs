#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isAppRunning, parseArgs, resolveAppPath, run } from './lib/app.mjs';
import { verifySignature } from './lib/install.mjs';

const args = parseArgs();
const appPath = resolveAppPath(args);
const backupRoot = path.resolve(args['backup-root'] || 'work/backups');

if (!existsSync(backupRoot)) {
  throw new Error(`没有备份目录：${backupRoot}`);
}

let backupDir = args.backup ? path.resolve(args.backup) : null;
if (!backupDir) {
  const candidates = readdirSync(backupRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(path.join(backupRoot, entry.name, 'Factory.app')))
    .map((entry) => {
      const dir = path.join(backupRoot, entry.name);
      let createdAt = '';
      try {
        createdAt = JSON.parse(readFileSync(path.join(dir, 'metadata.json'), 'utf8')).createdAt ?? '';
      } catch {
        createdAt = '';
      }
      return { dir, createdAt };
    })
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
  if (!candidates.length) throw new Error('备份目录中没有可用的 Factory.app');
  backupDir = candidates[0].dir;
}

const backupApp = path.join(backupDir, 'Factory.app');
if (!existsSync(backupApp)) throw new Error(`备份应用不存在：${backupApp}`);

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

console.log(`从备份恢复：${backupApp}`);
rmSync(appPath, { recursive: true, force: true });
run('/bin/cp', ['-cR', backupApp, appPath]);
const signature = verifySignature(appPath);
if (!signature.valid) throw new Error(`恢复后签名校验失败：${signature.detail}`);
rmSync(path.resolve('work/installed-state.json'), { force: true });
console.log(`\n恢复完成：${appPath}`);
console.log('签名校验通过（已还原为原始 Factory 签名）');