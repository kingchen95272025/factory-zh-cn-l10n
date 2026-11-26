import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadSourceCatalog, resolveRelease } from './lib/release.mjs';
import { countStrings } from './lib/text.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((item) => {
    const [key, value] = item.replace(/^--/, '').split('=');
    return [key, value ?? true];
  }),
);
const releaseId = resolveRelease(args.release);
const source = loadSourceCatalog(releaseId);
const targetSize = Number(args.size || 350);
const workRoot = path.resolve('work/translation');
const planPath = path.resolve('work/translation-plan.json');

// 已完整翻译的命名空间不再生成计划；部分翻译的会保留现有译文作为覆盖层。
const skip = new Set(['common']);

rmSync(workRoot, { recursive: true, force: true });
mkdirSync(workRoot, { recursive: true });

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function deepMerge(target, sourceValue) {
  for (const [key, value] of Object.entries(sourceValue)) {
    if (isPlainObject(value) && isPlainObject(target[key])) {
      deepMerge(target[key], value);
    } else {
      target[key] = value;
    }
  }
  return target;
}

function split(value, valuePath, max) {
  const total = countStrings(value);
  if (total === 0) return [];
  if (total <= max || !isPlainObject(value)) {
    return [{ path: valuePath, value, strings: total }];
  }
  const chunks = [];
  let current = null;
  let currentCount = 0;
  const flush = () => {
    if (current) {
      chunks.push(current);
      current = null;
      currentCount = 0;
    }
  };
  for (const [key, child] of Object.entries(value)) {
    const childCount = countStrings(child);
    if (childCount > max) {
      flush();
      chunks.push(...split(child, [...valuePath, key], max));
      continue;
    }
    if (!current || currentCount + childCount > max) {
      flush();
      current = { path: valuePath, value: {}, strings: 0 };
    }
    current.value[key] = child;
    current.strings += childCount;
    currentCount += childCount;
  }
  flush();
  return chunks;
}

const plan = [];
for (const [namespace, namespaceValue] of Object.entries(source.renderer)) {
  if (skip.has(namespace)) continue;
  const namespaceRoot = path.join(workRoot, namespace);
  mkdirSync(namespaceRoot, { recursive: true });
  const chunks = split(namespaceValue, [], targetSize);
  chunks.forEach((chunk, index) => {
    const id = `${namespace}-${String(index + 1).padStart(3, '0')}`;
    const sourceFile = path.join(namespaceRoot, `${id}.source.json`);
    const targetFile = path.join(namespaceRoot, `${id}.zh.json`);
    writeFileSync(sourceFile, `${JSON.stringify(chunk.value, null, 2)}\n`, 'utf8');
    plan.push({
      id,
      namespace,
      path: chunk.path,
      strings: chunk.strings,
      sourceFile: path.relative(process.cwd(), sourceFile),
      targetFile: path.relative(process.cwd(), targetFile),
    });
  });
}

writeFileSync(
  planPath,
  `${JSON.stringify(
    {
      releaseId,
      targetSize,
      generatedAt: new Date().toISOString(),
      chunks: plan,
      totals: {
        chunks: plan.length,
        strings: plan.reduce((sum, chunk) => sum + chunk.strings, 0),
      },
    },
    null,
    2,
  )}\n`,
  'utf8',
);

console.log(`版本：${releaseId}`);
console.log(`分块：${plan.length} 块，共 ${plan.reduce((sum, chunk) => sum + chunk.strings, 0)} 条字符串`);
const byNamespace = new Map();
for (const chunk of plan) {
  const entry = byNamespace.get(chunk.namespace) ?? { chunks: 0, strings: 0 };
  entry.chunks += 1;
  entry.strings += chunk.strings;
  byNamespace.set(chunk.namespace, entry);
}
for (const [namespace, entry] of [...byNamespace.entries()].sort((a, b) => b[1].strings - a[1].strings)) {
  console.log(`  ${namespace.padEnd(24)} ${String(entry.chunks).padStart(3)} 块  ${String(entry.strings).padStart(6)} 条`);
}
console.log(`计划：${path.relative(process.cwd(), planPath)}`);
if (!existsSync(path.join('translations', 'zh-CN', 'renderer'))) {
  mkdirSync(path.join('translations', 'zh-CN', 'renderer'), { recursive: true });
}