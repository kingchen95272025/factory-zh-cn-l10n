import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { normalizeChinesePlurals, validateNamespace } from './lib/text.mjs';

const planPath = path.resolve('work/translation-plan.json');
if (!existsSync(planPath)) throw new Error('缺少 work/translation-plan.json');
const plan = JSON.parse(readFileSync(planPath, 'utf8'));

const results = [];
for (const chunk of plan.chunks) {
  const sourcePath = path.resolve(chunk.sourceFile);
  const targetPath = path.resolve(chunk.targetFile);
  if (!existsSync(targetPath)) {
    results.push({ chunk, status: 'missing', missing: chunk.strings, extra: 0, errors: ['目标文件不存在'] });
    continue;
  }
  let source;
  let target;
  try {
    source = JSON.parse(readFileSync(sourcePath, 'utf8'));
    target = JSON.parse(readFileSync(targetPath, 'utf8'));
  } catch (error) {
    results.push({ chunk, status: 'invalid-json', missing: 0, extra: 0, errors: [error.message] });
    continue;
  }
  const notes = [];
  const normalized = normalizeChinesePlurals(target, chunk.id, notes);
  const validation = validateNamespace(source, normalized, chunk.id);
  results.push({
    chunk,
    status: validation.errors.length ? 'errors' : validation.missing ? 'partial' : 'ok',
    missing: validation.missing,
    extra: validation.errors.filter((error) => error.includes('不存在该键')).length,
    errors: validation.errors.slice(0, 8),
    warnings: validation.warnings.slice(0, 4),
  });
}

const failed = results.filter((result) => result.status !== 'ok');
const totals = results.reduce(
  (accumulator, result) => ({
    strings: accumulator.strings + result.chunk.strings,
    missing: accumulator.missing + (result.missing ?? 0),
  }),
  { strings: 0, missing: 0 },
);
console.log(`分块检查：${results.length - failed.length}/${results.length} 通过，缺失字符串 ${totals.missing}`);
for (const result of failed) {
  console.log(
    `\n✗ ${result.chunk.id} [${result.status}] 缺失 ${result.missing ?? '?'} 条：${result.chunk.targetFile}`,
  );
  for (const error of result.errors ?? []) console.log(`   - ${error}`);
}
if (!failed.length) console.log('全部分块结构与键集合通过');

writeFileSync(
  path.resolve('work/repair-plan.json'),
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      repairs: failed.map((result) => ({
        index: plan.chunks.indexOf(result.chunk),
        chunk: result.chunk,
        status: result.status,
        missing: result.missing,
        errors: result.errors ?? [],
      })),
    },
    null,
    2,
  )}\n`,
  'utf8',
);
if (failed.length) console.log(`修复计划：work/repair-plan.json（${failed.length} 块）`);