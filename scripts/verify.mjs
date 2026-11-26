#!/usr/bin/env node
import { parseArgs } from './lib/app.mjs';
import {
  loadManifest,
  loadSourceCatalog,
  loadTranslations,
  resolveRelease,
  translationPaths,
} from './lib/release.mjs';
import {
  formatPercent,
  normalizeChinesePlurals,
  summarize,
  validateNamespace,
} from './lib/text.mjs';

const args = parseArgs();
const releaseId = resolveRelease(args.release);
const lang = String(args.lang || 'zh-CN');
const manifest = loadManifest(releaseId);
const source = loadSourceCatalog(releaseId);
const translations = loadTranslations(lang);
const namespaceFilter = args.namespace ? String(args.namespace) : null;

const results = [];
const notes = [];
const missingNamespaces = [];

function runGroup(kind, sourceGroup, translationGroup) {
  for (const [name, sourceObject] of Object.entries(sourceGroup)) {
    if (namespaceFilter && name !== namespaceFilter) continue;
    const target = translationGroup[name];
    if (!target) {
      missingNamespaces.push(`${kind}/${name}`);
      const total = countStringsOf(sourceObject);
      results.push({
        namespace: `${kind}/${name}`,
        total,
        translated: 0,
        missing: total,
        coverage: 0,
        errors: [],
        warnings: [],
      });
      continue;
    }
    const normalized = normalizeChinesePlurals(target, name, notes);
    const result = validateNamespace(sourceObject, normalized, `${kind}/${name}`);
    results.push(result);
  }
}

function countStringsOf(object) {
  let total = 0;
  const walk = (value) => {
    if (typeof value === 'string') total += 1;
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') Object.values(value).forEach(walk);
  };
  walk(object);
  return total;
}

runGroup('renderer', source.renderer, translations.renderer);
runGroup('main', source.main, translations.main);

const totals = summarize(results);
const pathInfo = translationPaths(lang);

console.log(`Factory ${manifest.app.version} (build ${manifest.app.build})  语言：${lang}`);
console.log(`英文目录：${releaseId}`);
console.log(`译文目录：${pathInfo.renderer} / ${pathInfo.main}\n`);
console.log('命名空间                         覆盖率      已译/总数   缺失');
console.log('─'.repeat(68));
for (const result of results) {
  const label = result.namespace.padEnd(30);
  console.log(
    `${label} ${formatPercent(result.coverage).padStart(8)}  ${String(result.translated).padStart(6)}/${String(
      result.total,
    ).padEnd(7)} ${String(result.missing).padStart(5)}`,
  );
}
console.log('─'.repeat(68));
console.log(
  `合计${' '.repeat(26)}${formatPercent(totals.coverage).padStart(8)}  ${String(totals.translated).padStart(
    6,
  )}/${String(totals.total).padEnd(7)} ${String(totals.missing).padStart(5)}`,
);

if (missingNamespaces.length) {
  console.log(`\n尚未创建译文的命名空间（${missingNamespaces.length}）：`);
  console.log(`  ${missingNamespaces.join(', ')}`);
}
if (notes.length) {
  console.log(`\n规范化提示（${notes.length}）：`);
  for (const note of notes.slice(0, 20)) console.log(`  - ${note}`);
  if (notes.length > 20) console.log(`  ... 其余 ${notes.length - 20} 条已省略`);
}

const allErrors = results.flatMap((result) => result.errors);
const allWarnings = results.flatMap((result) => result.warnings);
if (allErrors.length) {
  console.error(`\n错误（${allErrors.length}）：`);
  for (const error of allErrors.slice(0, 40)) console.error(`  ✗ ${error}`);
  if (allErrors.length > 40) console.error(`  ... 其余 ${allErrors.length - 40} 条已省略`);
}
if (allWarnings.length) {
  console.log(`\n警告（${allWarnings.length}）：`);
  for (const warning of allWarnings.slice(0, 30)) console.log(`  ! ${warning}`);
  if (allWarnings.length > 30) console.log(`  ... 其余 ${allWarnings.length - 30} 条已省略`);
}

if (allErrors.length) process.exit(1);
if (args.strict && totals.coverage < 1) {
  console.error('\n--strict 要求全部字符串完成翻译');
  process.exit(1);
}
console.log('\n校验通过');