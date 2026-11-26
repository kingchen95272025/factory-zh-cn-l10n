import { loadSourceCatalog, loadTranslations } from './lib/release.mjs';
import { resolveRelease } from './lib/release.mjs';
import { flatten, validateNamespace } from './lib/text.mjs';

const releaseId = resolveRelease();
const source = loadSourceCatalog(releaseId);
const translations = loadTranslations('zh-CN');

const ALLOWED_ENGLISH = new Set([
  'Factory',
  'Droid',
  'droid',
  'Beta',
  'Wiki',
  'Slack',
  'Jira',
  'Linear',
  'GitHub',
  'GitLab',
  'Azure DevOps',
  'Google Chat',
  'Microsoft Teams',
  'Electron',
  'Node.js',
  'Chromium',
  'Rosetta',
  'API',
  'CLI',
  'PR',
  'ID',
  'OK',
  'Esc',
  'New',
  'MCP',
  'OAuth',
  'SSO',
  'SAML',
  'YAML',
  'JSON',
  'CSV',
  'PDF',
  'ZIP',
  'HTTP',
  'HTTPS',
  'URL',
  'UTF-8',
]);

function hasChinese(text) {
  return /[一-鿿]/.test(text);
}

function looksBrandOnly(text) {
  const tokens = text
    .replace(/\{\{[^}]+\}\}/g, ' ')
    .match(/[A-Za-z][A-Za-z0-9.+_-]*/g) ?? [];
  return tokens.length > 0 && tokens.every((token) => ALLOWED_ENGLISH.has(token));
}

const rows = [];
for (const [namespace, sourceObject] of Object.entries(source.renderer)) {
  const targetObject = translations.renderer[namespace];
  if (!targetObject) {
    rows.push({ namespace, total: flatten(sourceObject).size, translated: 0, missing: 'ALL', identical: 0, englishOnly: 0 });
    continue;
  }
  const sourceLeaves = flatten(sourceObject);
  const targetLeaves = flatten(targetObject);
  let total = 0;
  let translated = 0;
  let identical = 0;
  let englishOnly = 0;
  for (const [keyPath, sourceValue] of sourceLeaves) {
    if (typeof sourceValue !== 'string') continue;
    total += 1;
    const targetValue = targetLeaves.get(keyPath);
    if (typeof targetValue !== 'string') continue;
    translated += 1;
    if (targetValue === sourceValue && !looksBrandOnly(sourceValue)) identical += 1;
    if (!hasChinese(targetValue) && /[A-Za-z]{3,}/.test(sourceValue) && !looksBrandOnly(targetValue)) {
      englishOnly += 1;
    }
  }
  const validation = validateNamespace(sourceObject, targetObject, namespace);
  rows.push({
    namespace,
    total,
    translated,
    missing: total - translated,
    identical,
    englishOnly,
    errors: validation.errors.length,
  });
}

rows.sort((left, right) => right.missing - left.missing || right.englishOnly - left.englishOnly);
console.log('命名空间                 已译/总数      缺失  同文  纯英文  结构错误');
for (const row of rows) {
  console.log(
    `${row.namespace.padEnd(22)} ${String(row.translated).padStart(6)}/${String(row.total).padEnd(6)} ${String(
      row.missing,
    ).padStart(5)} ${String(row.identical).padStart(4)} ${String(row.englishOnly).padStart(6)} ${String(
      row.errors ?? 0,
    ).padStart(7)}`,
  );
}