#!/usr/bin/env node
import path from 'node:path';
import { isAppRunning, parseArgs, resolveAppPath, run } from './lib/app.mjs';
import { applyPatchToApp, resolveDist } from './lib/install.mjs';

const args = parseArgs();
const appPath = resolveAppPath(args);
const distDir = resolveDist(args.dist);
const backupRoot = path.resolve(args['backup-root'] || 'work/backups');

if (isAppRunning(appPath)) {
  if (args.quit) {
    console.log('正在退出 Factory…');
    try {
      run('/usr/bin/osascript', ['-e', 'tell application "Factory" to quit']);
    } catch {
      // 应用可能未注册 AppleScript 名称，继续用 pgrep 判断
    }
    for (let i = 0; i < 30; i += 1) {
      if (!isAppRunning(appPath)) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (isAppRunning(appPath)) {
      throw new Error('Factory 仍在运行，请手动退出后重试');
    }
  } else {
    throw new Error('Factory 正在运行。请先退出应用，或加 --quit 让脚本尝试退出');
  }
}

const result = applyPatchToApp({
  appPath,
  distDir,
  backupRoot,
  sign: !args['no-sign'],
  force: Boolean(args.force),
});

if (result.alreadyInstalled) {
  console.log('当前应用已经是该补丁版本，无需重复安装');
} else {
  console.log(`\n安装完成：${appPath}`);
  console.log(`补丁来源：${distDir}`);
  console.log(`原始备份：${result.backup.backupDir}`);
  console.log(`签名：${result.signing.signed ? 'ad-hoc 成功' : '未签名'}`);
  console.log('\n注意：');
  console.log('  1. 重新签名后 Squirrel 自动更新校验可能失败，升级前请先 npm run restore');
  console.log('  2. 若应用无法启动，使用 npm run restore 恢复原始应用');
}