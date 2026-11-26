import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve('translations/zh-CN');
const REPLACEMENTS = [
  ['套餐', '方案'],
  ['服务账户', '服务账号'],
  ['代金券', '优惠码'],
  ['Code Review', '代码审查'],
  ['Code review', '代码审查'],
];

const counts = new Map();
function replaceString(value, namespace) {
  let result = value;
  for (const [from, to] of REPLACEMENTS) {
    if (result.includes(from)) {
      const before = result;
      result = result.split(from).join(to);
      const key = `${namespace}: ${from} → ${to}`;
      counts.set(key, (counts.get(key) ?? 0) + (before.match(new RegExp(from, 'g'))?.length ?? 0));
    }
  }
  return result;
}

function walk(value, namespace) {
  if (typeof value === 'string') return replaceString(value, namespace);
  if (Array.isArray(value)) return value.map((item) => walk(item, namespace));
  if (value && typeof value === 'object') {
    const result = {};
    for (const [key, child] of Object.entries(value)) result[key] = walk(child, namespace);
    return result;
  }
  return value;
}

for (const dir of ['renderer', 'main/desktop']) {
  const base = path.join(ROOT, dir);
  for (const name of readdirSync(base)) {
    if (!name.endsWith('.json')) continue;
    const namespace = `${dir}/${name.slice(0, -5)}`;
    const filePath = path.join(base, name);
    const data = JSON.parse(readFileSync(filePath, 'utf8'));
    const updated = walk(data, namespace);
    writeFileSync(filePath, `${JSON.stringify(updated, null, 2)}\n`, 'utf8');
  }
}

if (!counts.size) {
  console.log('没有需要统一的术语');
} else {
  for (const [key, count] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`${key}：${count} 处`);
  }
}