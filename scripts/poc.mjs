#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { appInfo, parseArgs, resolveAppPath, run, sha256File } from './lib/app.mjs';
import { applyPatchToApp, loadPatchManifest, resolveDist } from './lib/install.mjs';
import { loadTranslations } from './lib/release.mjs';
import { flatten } from './lib/text.mjs';

const args = parseArgs();
const sourceApp = resolveAppPath(args);
const distDir = resolveDist(args.dist);
const dist = loadPatchManifest(distDir);
const releaseId = dist.releaseId;
const port = Number(args.port || 9333);
const pocRoot = path.resolve('work/poc', releaseId);
const targetApp = path.join(pocRoot, 'Factory-patched.app');
const userDataDir = path.resolve(args['user-data-dir'] || path.join(pocRoot, 'userdata'));
const screenshotPath = path.join(pocRoot, 'screenshot.png');
const textPath = path.join(pocRoot, 'body.txt');
const logPath = path.join(pocRoot, 'app.log');

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
      const message = JSON.parse(event.data);
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

function loadExpectedStrings(language) {
  const translations = loadTranslations(language);
  const expected = [];
  for (const object of Object.values(translations.renderer)) {
    for (const value of flatten(object).values()) {
      if (typeof value === 'string' && /[一-鿿]/.test(value)) expected.push(value);
    }
  }
  for (const object of Object.values(translations.main)) {
    for (const value of flatten(object).values()) {
      if (typeof value === 'string' && /[一-鿿]/.test(value)) expected.push(value);
    }
  }
  return expected;
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
run('/bin/cp', ['-cR', sourceApp, targetApp]);

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

let exitCode = 0;
try {
  const target = await waitForTarget(Number(args.timeout || 60000));
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

  const expected = loadExpectedStrings(dist.language);
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

  console.log(`\nhtml lang：${lang}`);
  console.log(`界面已稳定：${localized.settled ? '是' : '否（等待超时，可能是加载页）'}`);
  console.log(`界面中文字符数：${chineseCount}`);
  console.log(`命中的已翻译文案（${matched.length}）：${matched.slice(0, 12).join(' / ') || '无'}`);
  console.log(`正文前 300 字：\n${bodyText.slice(0, 300)}`);
  if (screenshot) console.log(`截图：${screenshot}`);

  if (lang !== dist.language) {
    console.error(`✗ html lang 期望 ${dist.language}，实际 ${lang}`);
    exitCode = 1;
  }
  if (chineseCount === 0) {
    console.error('✗ 界面上没有检测到中文，补丁未生效');
    exitCode = 1;
  }
  if (matched.length === 0) {
    console.error('✗ 界面未命中当前译文文件中的任何文案，PoC 无法证明补丁生效');
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