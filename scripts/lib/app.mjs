import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import path from 'node:path';

export const DEFAULT_APP = '/Applications/Factory.app';

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

export function resolveAppPath(args) {
  return path.resolve(String(args.app || process.env.FACTORY_APP || DEFAULT_APP));
}

export function assertAppBundle(appPath) {
  const asarPath = path.join(appPath, 'Contents/Resources/app.asar');
  const plistPath = path.join(appPath, 'Contents/Info.plist');
  if (!existsSync(asarPath) || !existsSync(plistPath)) {
    throw new Error(`不是有效的 Factory 应用包：${appPath}`);
  }
  return { asarPath, plistPath };
}

export function readInfoPlist(plistPath) {
  const json = execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plistPath], {
    encoding: 'utf8',
  });
  return JSON.parse(json);
}

export function appInfo(appPath) {
  const { asarPath, plistPath } = assertAppBundle(appPath);
  const plist = readInfoPlist(plistPath);
  return {
    appPath,
    asarPath,
    plistPath,
    version: plist.CFBundleShortVersionString,
    build: String(plist.CFBundleVersion),
    bundleId: plist.CFBundleIdentifier,
    integrityHash: plist.ElectronAsarIntegrity?.['Resources/app.asar']?.hash ?? null,
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
    const output = run('/usr/bin/pgrep', ['-f', `${appPath}/Contents/MacOS/Factory`]);
    return output.trim().length > 0;
  } catch {
    return false;
  }
}

export function readEntitlements(appPath) {
  try {
    return run('/usr/bin/codesign', ['-d', '--entitlements', ':-', appPath]);
  } catch (error) {
    const output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
    const start = output.indexOf('<?xml');
    return start >= 0 ? output.slice(start) : null;
  }
}

export function signatureInfo(appPath) {
  try {
    return run('/usr/bin/codesign', ['-dv', appPath], { stdio: 'pipe' });
  } catch (error) {
    return `${error.stdout ?? ''}${error.stderr ?? ''}`;
  }
}