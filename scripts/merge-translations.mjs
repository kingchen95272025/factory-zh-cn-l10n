import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadTranslations, translationPaths } from './lib/release.mjs';
import { sortDeep } from './lib/catalog.mjs';
import { normalizeChinesePlurals } from './lib/text.mjs';

const planPath = path.resolve('work/translation-plan.json');
if (!existsSync(planPath)) throw new Error('缺少 work/translation-plan.json，请先运行 npm run plan:translation');
const plan = JSON.parse(readFileSync(planPath, 'utf8'));
const language = 'zh-CN';
const paths = translationPaths(language);
const existing = loadTranslations(language).renderer;
const notes = [];

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function deepMerge(target, sourceValue) {
  for (const [key, value] of Object.entries(sourceValue)) {
    if (isPlainObject(value) && isPlainObject(target[key])) deepMerge(target[key], value);
    else target[key] = value;
  }
  return target;
}

function mergeAt(root, valuePath, value) {
  if (valuePath.length === 0) {
    deepMerge(root, value);
    return;
  }
  let target = root;
  for (const key of valuePath.slice(0, -1)) {
    target[key] ??= {};
    target = target[key];
  }
  const last = valuePath[valuePath.length - 1];
  target[last] ??= {};
  deepMerge(target[last], value);
}

const byNamespace = new Map();
for (const chunk of plan.chunks) {
  const list = byNamespace.get(chunk.namespace) ?? [];
  list.push(chunk);
  byNamespace.set(chunk.namespace, list);
}

const report = [];
for (const [namespace, chunks] of byNamespace) {
  const merged = {};
  let missingChunks = 0;
  for (const chunk of chunks) {
    const targetFile = path.resolve(chunk.targetFile);
    if (!existsSync(targetFile)) {
      missingChunks += 1;
      continue;
    }
    try {
      mergeAt(merged, chunk.path, JSON.parse(readFileSync(targetFile, 'utf8')));
    } catch (error) {
      console.error(`✗ ${chunk.id} 解析失败：${error.message}`);
      missingChunks += 1;
    }
  }
  if (existing[namespace]) deepMerge(merged, existing[namespace]);
  const normalized = normalizeChinesePlurals(merged, namespace, notes);
  const filePath = path.join(paths.renderer, `${namespace}.json`);
  writeFileSync(filePath, `${JSON.stringify(sortDeep(normalized), null, 2)}\n`, 'utf8');
  report.push({ namespace, chunks: chunks.length, missingChunks });
}

for (const entry of report.sort((a, b) => a.namespace.localeCompare(b.namespace))) {
  console.log(
    `${entry.namespace.padEnd(24)} ${entry.chunks} 块${entry.missingChunks ? `，缺 ${entry.missingChunks} 块` : ''}`,
  );
}
const totalMissing = report.reduce((sum, entry) => sum + entry.missingChunks, 0);
console.log(`合并完成：${report.length} 个命名空间${totalMissing ? `，${totalMissing} 块缺失` : ''}`);
if (notes.length) console.log(`复数规范化提示：${notes.length} 条`);