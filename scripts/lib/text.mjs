const PLURAL_SUFFIXES = ['zero', 'one', 'two', 'few', 'many', 'other'];
const PLACEHOLDER_RE = /\{\{[^{}]+\}\}/g;
const NESTED_REF_RE = /\$t\(([^)]+)\)/g;

export function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function flatten(value, prefix = '', out = new Map()) {
  if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      flatten(child, prefix ? `${prefix}.${key}` : key, out);
    }
  } else if (Array.isArray(value)) {
    value.forEach((child, index) => flatten(child, `${prefix}[${index}]`, out));
  } else {
    out.set(prefix, value);
  }
  return out;
}

export function countLeaves(value) {
  return flatten(value).size;
}

export function countStrings(value) {
  let total = 0;
  for (const leaf of flatten(value).values()) {
    if (typeof leaf === 'string') total += 1;
  }
  return total;
}

export function placeholders(text) {
  return new Set(String(text).match(PLACEHOLDER_RE) ?? []);
}

export function nestedRefs(text) {
  return new Set(
    Array.from(String(text).matchAll(NESTED_REF_RE), (match) => match[1].trim()),
  );
}

export function pluralBase(key) {
  const match = key.match(new RegExp(`^(.*)_(${PLURAL_SUFFIXES.join('|')})$`));
  return match ? { base: match[1], suffix: match[2] } : null;
}

export function splitPluralGroups(object) {
  const groups = new Map();
  for (const key of Object.keys(object)) {
    const info = pluralBase(key);
    if (!info) continue;
    const list = groups.get(info.base) ?? [];
    list.push({ key, suffix: info.suffix });
    groups.set(info.base, list);
  }
  return groups;
}

/**
 * 中文（zh-CN）在 i18next 中只有 _other 复数形态。
 * 这里把译者可能提供的 _one/_few/_many 归并到 _other，并返回提示信息。
 */
export function normalizeChinesePlurals(object, path = '', notes = []) {
  if (Array.isArray(object)) {
    return object.map((item, index) => normalizeChinesePlurals(item, `${path}[${index}]`, notes));
  }
  if (!isPlainObject(object)) return object;

  const result = {};
  for (const [key, value] of Object.entries(object)) {
    result[key] = normalizeChinesePlurals(value, path ? `${path}.${key}` : key, notes);
  }

  const groups = splitPluralGroups(result);
  for (const [base, entries] of groups) {
    const other = entries.find((entry) => entry.suffix === 'other');
    if (other) {
      for (const entry of entries) {
        if (entry.suffix !== 'other') {
          delete result[entry.key];
          notes.push(`已忽略 ${path ? `${path}.` : ''}${entry.key}（中文只使用 _other）`);
        }
      }
    } else if (entries.length === 1) {
      const [entry] = entries;
      result[`${base}_other`] = result[entry.key];
      delete result[entry.key];
      notes.push(`已将 ${path ? `${path}.` : ''}${entry.key} 规范为 ${base}_other`);
    } else {
      notes.push(`${path ? `${path}.` : ''}${base} 缺少 _other 复数键`);
    }
  }
  return result;
}

export function setEquals(left, right) {
  if (left.size !== right.size) return false;
  for (const item of left) if (!right.has(item)) return false;
  return true;
}

export function validatePair(sourceText, targetText, keyPath) {
  const errors = [];
  const warnings = [];
  if (typeof targetText !== 'string') {
    errors.push(`${keyPath}: 译文必须是字符串，实际为 ${typeof targetText}`);
    return { errors, warnings };
  }
  if (!targetText.trim()) {
    errors.push(`${keyPath}: 译文为空`);
    return { errors, warnings };
  }
  const sourcePlaceholders = placeholders(sourceText);
  const targetPlaceholders = placeholders(targetText);
  if (!setEquals(sourcePlaceholders, targetPlaceholders)) {
    errors.push(
      `${keyPath}: 占位符不一致（源 ${[...sourcePlaceholders].join(', ') || '无'} / 译 ${
        [...targetPlaceholders].join(', ') || '无'
      }）`,
    );
  }
  const sourceRefs = nestedRefs(sourceText);
  const targetRefs = nestedRefs(targetText);
  if (!setEquals(sourceRefs, targetRefs)) {
    errors.push(
      `${keyPath}: $t() 引用不一致（源 ${[...sourceRefs].join(', ') || '无'} / 译 ${
        [...targetRefs].join(', ') || '无'
      }）`,
    );
  }
  const localizedFeatureName =
    sourceText.includes('Software Factory') && targetText.includes('软件工厂');
  for (const brand of ['Factory', 'droid']) {
    const sourceHas = sourceText.toLowerCase().includes(brand.toLowerCase());
    const targetHas = targetText.toLowerCase().includes(brand.toLowerCase());
    if (sourceHas && !targetHas && !localizedFeatureName) {
      warnings.push(`${keyPath}: 源文包含产品名 ${brand}，译文未保留`);
    }
  }
  if (sourceText === targetText) {
    const brandOnly = /^(Factory|Droid|droid)(\s*\{\{[^{}]+\}\})?$/.test(sourceText.trim());
    if (!brandOnly) warnings.push(`${keyPath}: 译文与英文源相同（可能未翻译）`);
  }
  return { errors, warnings };
}

export function validateNamespace(sourceObject, targetObject, namespace) {
  const sourceLeaves = flatten(sourceObject);
  const targetLeaves = flatten(targetObject);
  const errors = [];
  const warnings = [];
  let translated = 0;

  const isRedundantPlural = (keyPath) => {
    const lastSegment = keyPath.split('.').pop();
    const info = pluralBase(lastSegment);
    if (!info || info.suffix === 'other') return false;
    const prefix = keyPath.slice(0, -(info.suffix.length + 1));
    return sourceLeaves.has(`${prefix}_other`);
  };

  for (const [keyPath, sourceValue] of sourceLeaves) {
    if (isRedundantPlural(keyPath)) continue;
    const targetValue = targetLeaves.get(keyPath);
    if (targetValue === undefined) continue;
    if (typeof sourceValue !== 'string') {
      if (JSON.stringify(sourceValue) !== JSON.stringify(targetValue)) {
        warnings.push(`${namespace}.${keyPath}: 非字符串字段被修改`);
      }
      continue;
    }
    const result = validatePair(sourceValue, targetValue, `${namespace}.${keyPath}`);
    errors.push(...result.errors);
    warnings.push(...result.warnings);
    translated += 1;
  }

  for (const keyPath of targetLeaves.keys()) {
    if (!sourceLeaves.has(keyPath)) {
      errors.push(`${namespace}.${keyPath}: 源目录中不存在该键`);
    }
  }

  const total = Array.from(sourceLeaves.entries()).filter(
    ([keyPath, value]) => typeof value === 'string' && !isRedundantPlural(keyPath),
  ).length;
  return {
    namespace,
    total,
    translated,
    missing: total - translated,
    coverage: total === 0 ? 1 : translated / total,
    errors,
    warnings,
  };
}

export function summarize(results) {
  const totals = results.reduce(
    (accumulator, result) => ({
      total: accumulator.total + result.total,
      translated: accumulator.translated + result.translated,
      missing: accumulator.missing + result.missing,
      errors: accumulator.errors + result.errors.length,
      warnings: accumulator.warnings + result.warnings.length,
    }),
    { total: 0, translated: 0, missing: 0, errors: 0, warnings: 0 },
  );
  totals.coverage = totals.total === 0 ? 1 : totals.translated / totals.total;
  return totals;
}

export function formatPercent(value) {
  return `${(value * 100).toFixed(1)}%`;
}