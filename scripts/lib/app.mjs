import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as asar from '@electron/asar';

export const DEFAULT_APP = process.platform === 'darwin' ? '/Applications/Factory.app' : null;

export function parseArgs(argv = process.argv.slice(2)) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith('--')) {
      args._.push(item);
      continue;
    }
    const [key, inlineValue] = item.slice(2).split('=');
    if (inlineValue !== undefined) {
      args[key] = inlineValue;
    } else if (argv[i + 1] && !argv[i + 1].startsWith('--')) {
      args[key] = argv[i + 1];
      i += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function uniqueExisting(candidates) {
  return [...new Set(candidates.map((item) => path.resolve(item)).filter((item) => existsSync(item)))];
}

export function discoverApps() {
  const home = os.homedir();
  const candidates = [];

  if (process.platform === 'darwin') {
    candidates.push('/Applications/Factory.app', path.join(home, 'Applications/Factory.app'));
  }

  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData/Local');
    const squirrelRoot = path.join(localAppData, 'Factory');
    if (existsSync(squirrelRoot)) {
      for (const entry of readdirSync(squirrelRoot, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name.startsWith('app-')) {
          candidates.push(path.join(squirrelRoot, entry.name));
        }
      }
    }
    candidates.push(
      path.join(localAppData, 'Programs/Factory'),
      path.join(process.env.PROGRAMFILES || 'C:/Program Files', 'Factory'),
      path.join(process.env['PROGRAMFILES(X86)'] || 'C:/Program Files (x86)', 'Factory'),
    );
  }

  if (process.platform === 'linux') {
    candidates.push(
      '/opt/Factory',
      '/opt/factory',
      '/usr/lib/factory',
      '/usr/share/factory',
      path.join(home, '.local/share/Factory'),
      path.join(home, '.local/opt/Factory'),
    );
  }

  const apps = [];
  for (const candidate of uniqueExisting(candidates)) {
    try {
      inspectLayout(candidate);
      apps.push(candidate);
    } catch {
      // 不是有效的 Factory 安装目录
    }
  }
  return apps;
}

export function resolveAppPath(args = {}) {
  const explicit = args.app || process.env.FACTORY_APP;
  if (explicit) {
    const resolved = path.resolve(String(explicit));
    inspectLayout(resolved);
    return resolved;
  }
  const apps = discoverApps();
  if (!apps.length) {
    throw new Error(
      `未自动找到 Factory 安装目录。请用 --app 指定应用路径。\n` +
        `macOS 示例：--app /Applications/Factory.app\n` +
        `Windows 示例：--app "%LOCALAPPDATA%\\Factory\\app-1.20.0"\n` +
        `Linux 示例：--app /opt/Factory`,
    );
  }
  if (apps.length > 1) {
    throw new Error(`检测到多个 Factory 安装，请用 --app 指定：\n${apps.map((item) => `  - ${item}`).join('\n')}`);
  }
  return apps[0];
}

/**
 * 支持的布局：
 * - mac：Factory.app/Contents/Resources/app.asar（带 Info.plist 与签名）
 * - dir：安装目录/resources/app.asar（Windows Squirrel、Linux deb/rpm）
 * - resources：直接指向 resources 目录
 * - asar：直接指向 app.asar
 */
export function inspectLayout(appPath) {
  const resolved = path.resolve(appPath);
  const macAsar = path.join(resolved, 'Contents/Resources/app.asar');
  if (existsSync(macAsar)) {
    return {
      layout: 'mac',
      platform: 'darwin',
      appRoot: resolved,
      resourcesDir: path.join(resolved, 'Contents/Resources'),
      asarPath: macAsar,
      plistPath: path.join(resolved, 'Contents/Info.plist'),
    };
  }

  const dirAsar = path.join(resolved, 'resources/app.asar');
  if (existsSync(dirAsar)) {
    return {
      layout: 'dir',
      platform: process.platform,
      appRoot: resolved,
      resourcesDir: path.join(resolved, 'resources'),
      asarPath: dirAsar,
      plistPath: null,
    };
  }

  const resourcesAsar = path.join(resolved, 'app.asar');
  if (existsSync(resourcesAsar)) {
    return {
      layout: 'resources',
      platform: process.platform,
      appRoot: path.dirname(resolved),
      resourcesDir: resolved,
      asarPath: resourcesAsar,
      plistPath: null,
    };
  }

  if (resolved.endsWith('.asar') && existsSync(resolved)) {
    const resourcesDir = path.dirname(resolved);
    return {
      layout: 'asar',
      platform: process.platform,
      appRoot: path.dirname(resourcesDir),
      resourcesDir,
      asarPath: resolved,
      plistPath: null,
    };
  }

  throw new Error(`不是有效的 Factory 应用目录：${resolved}`);
}

export function assertAppBundle(appPath) {
  return inspectLayout(appPath);
}

export function readInfoPlist(plistPath) {
  if (process.platform !== 'darwin') {
    throw new Error('读取 Info.plist 仅支持 macOS');
  }
  const json = execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plistPath], {
    encoding: 'utf8',
  });
  return JSON.parse(json);
}

export function readPackageJsonFromAsar(asarPath) {
  try {
    const buffer = asar.extractFile(asarPath, 'package.json');
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    return null;
  }
}

export function appInfo(appPath) {
  const layout = inspectLayout(appPath);
  if (layout.layout === 'mac') {
    const plist = readInfoPlist(layout.plistPath);
    return {
      ...layout,
      appPath: layout.appRoot,
      version: plist.CFBundleShortVersionString,
      build: plist.CFBundleVersion === undefined ? null : String(plist.CFBundleVersion),
      bundleId: plist.CFBundleIdentifier,
      integrityHash: plist.ElectronAsarIntegrity?.['Resources/app.asar']?.hash ?? null,
      productName: plist.CFBundleDisplayName ?? plist.CFBundleName ?? 'Factory',
    };
  }

  const packageJson = readPackageJsonFromAsar(layout.asarPath);
  if (!packageJson) {
    throw new Error(`无法从 app.asar 读取 package.json：${layout.asarPath}`);
  }
  const squirrelVersion = path.basename(layout.appRoot).match(/^app-(.+)$/)?.[1] ?? null;
  return {
    ...layout,
    appPath: layout.appRoot,
    version: squirrelVersion ?? packageJson.version ?? 'unknown',
    build: null,
    bundleId: packageJson.name ?? null,
    integrityHash: null,
    productName: packageJson.productName ?? packageJson.name ?? 'Factory',
  };
}

export function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

export function sha256Text(text) {
  return createHash('sha256').update(text).digest('hex');
}

export function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: options.stdio ?? 'pipe',
    ...options,
  });
}

export function isAppRunning(appPath) {
  try {
    if (process.platform === 'darwin') {
      const layout = inspectLayout(appPath);
      const executable = path.join(layout.appRoot, 'Contents/MacOS/Factory');
      return run('/usr/bin/pgrep', ['-f', executable]).trim().length > 0;
    }
    if (process.platform === 'win32') {
      const output = run('tasklist', ['/FI', 'IMAGENAME eq Factory.exe', '/FO', 'CSV', '/NH']);
      return output.toLowerCase().includes('factory.exe');
    }
    const output = run('pgrep', ['-f', 'Factory']);
    return output.trim().length > 0;
  } catch {
    return false;
  }
}

export function quitApp(appPath) {
  try {
    if (process.platform === 'darwin') {
      run('/usr/bin/osascript', ['-e', 'tell application "Factory" to quit']);
    } else if (process.platform === 'win32') {
      run('taskkill', ['/IM', 'Factory.exe', '/F']);
    } else {
      run('pkill', ['-f', 'Factory']);
    }
    return true;
  } catch {
    return false;
  }
}

export function readEntitlements(appPath) {
  if (process.platform !== 'darwin') return null;
  try {
    return run('/usr/bin/codesign', ['-d', '--entitlements', ':-', appPath]);
  } catch (error) {
    const output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
    const start = output.indexOf('<?xml');
    return start >= 0 ? output.slice(start) : null;
  }
}

export function signatureInfo(appPath) {
  if (process.platform !== 'darwin') return 'not applicable';
  try {
    return run('/usr/bin/codesign', ['-dv', appPath], { stdio: 'pipe' });
  } catch (error) {
    return `${error.stdout ?? ''}${error.stderr ?? ''}`;
  }
}

export function defaultStateRoot() {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return path.join(home, 'Library/Application Support/factory-l10n');
  }
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData/Local'), 'factory-l10n');
  }
  return path.join(process.env.XDG_STATE_HOME || path.join(home, '.local/state'), 'factory-l10n');
}