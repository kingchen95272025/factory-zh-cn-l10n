#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import * as asar from '@electron/asar';
import { WebSocket } from 'ws';
import { appInfo, parseArgs, resolveAppPath, run, sha256File } from './lib/app.mjs';
import { hasChinesePack } from './lib/asar.mjs';
import {
  applyPatchToApp,
  findOriginalBackup,
  loadPatchManifest,
  resolveDist,
} from './lib/install.mjs';
import { flatten } from './lib/text.mjs';

const args = parseArgs();
const sourceApp = resolveAppPath(args);
const distDir = resolveDist(args.dist);
const dist = loadPatchManifest(distDir);
const releaseId = dist.releaseId;
const pocRoot = path.resolve('work/poc', releaseId);
const targetApp = path.join(pocRoot, 'Factory-patched.app');
const userDataDir = path.resolve(args['user-data-dir'] || path.join(pocRoot, 'userdata'));
const screenshotPath = path.join(pocRoot, 'screenshot.png');
const textPath = path.join(pocRoot, 'body.txt');
const logPath = path.join(pocRoot, 'app.log');

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port: freePort } = server.address();
      server.close(() => resolve(freePort));
    });
  });
}

const port = args.port ? Number(args.port) : await getFreePort();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForTarget(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await response.json();
      const page = list.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
      if (page) return page;
    } catch (error) {
      lastError = error;
    }
    await sleep(300);
  }
  throw new Error(`等待远程调试端口超时：${lastError?.message ?? 'unknown'}`);
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl);
    let nextId = 0;
    const pending = new Map();
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id && pending.has(message.id)) {
        const { resolve: done, reject: fail } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) fail(new Error(message.error.message));
        else done(message.result);
      }
    });
    socket.addEventListener('error', reject);
    socket.addEventListener('open', () => {
      resolve({
        send(method, params = {}) {
          const id = ++nextId;
          return new Promise((done, fail) => {
            pending.set(id, { resolve: done, reject: fail });
            socket.send(JSON.stringify({ id, method, params }));
          });
        },
        close() {
          socket.close();
        },
      });
    });
  });
}

async function evaluate(client, expression) {
  const result = await client.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    throw new Error(`页面求值失败：${result.exceptionDetails.text}`);
  }
  return result.result.value;
}

async function waitForBridge(client, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(client, 'Boolean(window.electronAPI && window.electronAPI.i18n)')) return true;
    await sleep(300);
  }
  return false;
}

async function waitForLang(client, expectedLang, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lang = '';
  while (Date.now() < deadline) {
    lang = await evaluate(client, 'document.documentElement.lang');
    if (lang === expectedLang) return lang;
    await sleep(300);
  }
  return lang;
}

async function waitForLocalizedText(client, expected, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let state = { lang: '', text: '', matched: [] };
  while (Date.now() < deadline) {
    state = await evaluate(
      client,
      `(() => ({
        lang: document.documentElement.lang,
        text: document.body ? document.body.innerText : "",
      }))()`,
    );
    state.matched = expected.filter((text) => state.text.includes(text));
    const loading = /Starting Factory|Loading your organization|Updating Factory/.test(state.text);
    if (state.lang === 'zh-CN' && state.matched.length > 0 && !loading) {
      return { ...state, settled: true };
    }
    await sleep(500);
  }
  return { ...state, settled: false };
}

function loadExpectedStrings() {
  const chunkPath = path.join(distDir, dist.renderer.chunk);
  if (!existsSync(chunkPath)) {
    throw new Error(`dist 中缺少资源分块 ${dist.renderer.chunk}，请重新运行 npm run build`);
  }
  const source = readFileSync(chunkPath, 'utf8');
  const start = source.indexOf('=');
  const end = source.lastIndexOf(';export');
  if (start < 0 || end < 0) throw new Error('无法解析资源分块结构');
  const resources = JSON.parse(source.slice(start + 1, end));
  return [...flatten(resources).values()].filter(
    (value) => typeof value === 'string' && /[一-鿿]/.test(value),
  );
}

function extractJsonLiteral(text, startIndex) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = startIndex; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(startIndex, index + 1);
    }
  }
  throw new Error('主进程中文资源 JSON 未闭合');
}

function verifyMainStatic() {
  const asarPath = path.join(targetApp, 'Contents/Resources/app.asar');
  const buffer = asar.extractFile(asarPath, dist.main.bundle);
  const text = buffer.toString('utf8');
  const marker = '__FACTORY_ZH_CN_DESKTOP__=';
  const markerIndex = text.indexOf(marker);
  const mapPresent = text.includes(`[${dist.main.enumName}.ChineseSimplified]:{desktop:`);
  if (markerIndex < 0) return { ok: false, reason: '未找到主进程中文资源变量' };
  const jsonStart = text.indexOf('{', markerIndex + marker.length);
  const desktop = JSON.parse(extractJsonLiteral(text, jsonStart));
  const chinese = (JSON.stringify(desktop).match(/[一-鿿]/g) ?? []).length;
  return { ok: mapPresent && chinese > 0, mapPresent, chinese };
}

function readMainMenu(pid) {
  const script = `tell application "System Events" to tell (first process whose unix id is ${pid}) to get name of every menu bar item of menu bar 1`;
  const result = spawnSync('/usr/bin/osascript', ['-e', script], { encoding: 'utf8' });
  if (result.status !== 0) {
    return { available: false, error: `${result.stderr ?? ''}`.trim() };
  }
  return { available: true, items: result.stdout.trim().split(', ').filter(Boolean) };
}

function killTree(child) {
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    // 进程可能已退出
  }
  try {
    run('/usr/bin/pkill', ['-f', `${targetApp}/Contents/Resources/bin/droid`]);
  } catch {
    // 没有守护进程
  }
}

if (existsSync(pocRoot) && !args.reuse) {
  rmSync(pocRoot, { recursive: true, force: true });
}
mkdirSync(pocRoot, { recursive: true });
mkdirSync(userDataDir, { recursive: true });

console.log(`创建隔离副本：${targetApp}`);
const sourceInfo = appInfo(sourceApp);
let copySource = sourceApp;
if (hasChinesePack(sourceInfo.asarPath)) {
  const original = findOriginalBackup(
    path.resolve(args['backup-root'] || 'work/backups'),
    dist.app.sourceAsarSha256,
  );
  if (!original) {
    throw new Error(
      '当前安装的是补丁版应用，且找不到对应的原始备份。请先 npm run restore，或用 --app 指定原始应用。',
    );
  }
  copySource = original.backupApp;
  console.log(`检测到补丁版应用，改用原始备份作为 PoC 源：${copySource}`);
}
run('/bin/cp', ['-cR', copySource, targetApp]);

console.log(`向副本注入补丁：${distDir}`);
const patchResult = applyPatchToApp({
  appPath: targetApp,
  distDir,
  backupRoot: path.join(pocRoot, 'backups'),
  sign: true,
  force: false,
});
if (patchResult.alreadyInstalled) console.log('副本已是最新补丁');

const info = appInfo(targetApp);
const asarSha = await sha256File(info.asarPath);
console.log(`副本 asar SHA-256：${asarSha}`);
const mainStatic = verifyMainStatic();
console.log(
  `主进程中文资源静态校验：${mainStatic.ok ? '通过' : '失败'}${
    mainStatic.ok ? `（${mainStatic.chinese} 个中文字符）` : `（${mainStatic.reason ?? '缺少 zh-CN desktop 资源'}）`
  }`,
);

const stdout = openSync(logPath, 'w');
const stderr = openSync(logPath, 'a');
const launchArgs = [
  `--user-data-dir=${userDataDir}`,
  `--remote-debugging-port=${port}`,
  '--lang=zh-CN',
];
console.log(`启动副本：${targetApp}/Contents/MacOS/Factory ${launchArgs.join(' ')}`);
const child = spawn(`${targetApp}/Contents/MacOS/Factory`, launchArgs, {
  detached: true,
  stdio: ['ignore', stdout, stderr],
  env: { ...process.env },
});
child.unref();

const shutdown = (signal) => {
  console.error(`收到 ${signal}，清理 PoC 进程…`);
  killTree(child);
  process.exit(130);
};
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

let exitCode = 0;
try {
  const target = await waitForTarget(Number(args.timeout || 60000));
  if (!target.url.includes(targetApp) && !target.url.includes('Factory-patched.app')) {
    throw new Error(`DevTools target 不属于本次 PoC 副本：${target.url}`);
  }
  console.log(`已连接渲染进程：${target.url}`);
  const client = await connect(target.webSocketDebuggerUrl);
  await client.send('Runtime.enable');
  await client.send('Page.enable');

  const bridgeReady = await waitForBridge(client, 30000);
  console.log(`i18n 桥接就绪：${bridgeReady}`);

  let diagnostics = null;
  try {
    diagnostics = await evaluate(
      client,
      `(async () => {
        const bridge = window.electronAPI && window.electronAPI.i18n;
        let preference = null;
        try {
          preference = bridge ? await Promise.race([
            bridge.getPreference(),
            new Promise((resolve) => setTimeout(() => resolve('timeout'), 3000)),
          ]) : null;
        } catch (error) {
          preference = { error: String(error) };
        }
        return {
          navigatorLanguages: navigator.languages,
          preference,
          startupLocale: localStorage.getItem('factory-app-startup-locale'),
          htmlLang: document.documentElement.lang,
          hasI18nBridge: Boolean(bridge),
        };
      })()`,
    );
    console.log(`运行时诊断：${JSON.stringify(diagnostics)}`);
  } catch (error) {
    console.warn(`诊断读取失败：${error.message}`);
  }

  const expected = loadExpectedStrings();
  let initialLang = await evaluate(client, 'document.documentElement.lang');
  if (initialLang !== dist.language && bridgeReady && !args['no-select']) {
    console.log(`初始语言为 ${initialLang}，模拟用户在设置中选择 ${dist.language}`);
    try {
      await evaluate(client, `window.electronAPI.i18n.setLocale(${JSON.stringify(dist.language)})`);
    } catch (error) {
      console.warn(`setLocale 失败：${error.message}`);
    }
    initialLang = await waitForLang(client, dist.language, 20000);
    console.log(`切换后 html lang：${initialLang}`);
  }

  const localized = await waitForLocalizedText(client, expected, Number(args.timeout || 90000));
  const bodyText = localized.text;
  const lang = localized.lang;
  const matched = localized.matched;
  writeFileSync(textPath, `${bodyText}\n`, 'utf8');
  const chineseCount = (bodyText.match(/[一-鿿]/g) ?? []).length;

  let screenshot = null;
  try {
    const capture = await client.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(screenshotPath, Buffer.from(capture.data, 'base64'));
    screenshot = screenshotPath;
  } catch (error) {
    console.warn(`截图失败：${error.message}`);
  }

  const mainMenu = readMainMenu(child.pid);
  if (mainMenu.available) {
    console.log(`原生菜单栏：${mainMenu.items.join(' / ')}`);
    console.log(`原生菜单中文：${mainMenu.items.some((item) => /[一-鿿]/.test(item)) ? '是' : '否'}`);
  } else {
    console.log('原生菜单检查：不可用（需要辅助功能权限，跳过）');
  }

  console.log(`\nhtml lang：${lang}`);
  console.log(`界面已稳定：${localized.settled ? '是' : '否（等待超时，可能是加载页）'}`);
  console.log(`主进程中文资源：${mainStatic.ok ? '通过' : '失败'}`);
  console.log(`界面中文字符数：${chineseCount}`);
  console.log(`命中的构建产物文案（${matched.length}）：${matched.slice(0, 12).join(' / ') || '无'}`);
  console.log(`正文前 300 字：\n${bodyText.slice(0, 300)}`);
  if (screenshot) console.log(`截图：${screenshot}`);

  if (!localized.settled) {
    console.error('✗ 界面未在超时内稳定，拒绝以加载页作为 PoC 结论');
    exitCode = 1;
  }
  if (!mainStatic.ok) {
    console.error('✗ 主进程中文资源静态校验失败，原生菜单/对话框不会被翻译');
    exitCode = 1;
  }
  if (lang !== dist.language) {
    console.error(`✗ html lang 期望 ${dist.language}，实际 ${lang}`);
    exitCode = 1;
  }
  if (chineseCount === 0) {
    console.error('✗ 界面上没有检测到中文，补丁未生效');
    exitCode = 1;
  }
  if (matched.length === 0) {
    console.error('✗ 界面未命中构建产物中的任何文案，PoC 无法证明补丁生效');
    exitCode = 1;
  }
  client.close();
} catch (error) {
  console.error(`✗ PoC 失败：${error.message}`);
  console.error(`应用日志：${logPath}`);
  exitCode = 1;
} finally {
  killTree(child);
  await sleep(1200);
  try {
    run('/usr/bin/pkill', ['-9', '-f', targetApp]);
  } catch {
    // 已全部退出
  }
}

process.exit(exitCode);