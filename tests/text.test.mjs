import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeChinesePlurals,
  validateNamespace,
  validatePair,
  placeholders,
  splitPluralGroups,
} from '../scripts/lib/text.mjs';

test('占位符集合必须一致', () => {
  const ok = validatePair('Hello {{name}}, {{count}} items', '你好 {{name}}，{{count}} 项', 'k');
  assert.deepEqual(ok.errors, []);
  const bad = validatePair('Hello {{name}}', '你好', 'k');
  assert.equal(bad.errors.length, 1);
  assert.match(bad.errors[0], /占位符不一致/);
});

test('$t() 引用必须一致', () => {
  const ok = validatePair('Read $t(settings.title) now', '阅读 $t(settings.title)', 'k');
  assert.deepEqual(ok.errors, []);
  const bad = validatePair('Read $t(settings.title)', '阅读', 'k');
  assert.equal(bad.errors.length, 1);
});

test('中文复数归并到 _other', () => {
  const notes = [];
  const normalized = normalizeChinesePlurals({
    count_one: '{{count}} 项',
    count_other: '{{count}} 项',
    nested: { day_one: '{{count}} 天', day_other: '{{count}} 天' },
  }, 'ns', notes);
  assert.deepEqual(Object.keys(normalized), ['count_other', 'nested']);
  assert.deepEqual(Object.keys(normalized.nested), ['day_other']);
  assert.ok(notes.length >= 2);
});

test('只有 _one 时自动规范为 _other', () => {
  const notes = [];
  const normalized = normalizeChinesePlurals({ count_one: '{{count}} 项' }, 'ns', notes);
  assert.deepEqual(Object.keys(normalized), ['count_other']);
  assert.match(notes[0], /规范为 count_other/);
});

test('覆盖率不把英文的 _one/_few 计入缺失', () => {
  const source = {
    title: 'Quit Factory?',
    active_one: 'You have {{count}} session',
    active_other: 'You have {{count}} sessions',
  };
  const target = { title: '退出 Factory？', active_other: '你有 {{count}} 个会话' };
  const result = validateNamespace(source, target, 'main/quitGuard');
  assert.equal(result.total, 2);
  assert.equal(result.translated, 2);
  assert.equal(result.missing, 0);
  assert.deepEqual(result.errors, []);
});

test('多余键必须报错', () => {
  const result = validateNamespace({ a: 'A' }, { a: '甲', b: '乙' }, 'ns');
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /不存在该键/);
});

test('产品名保留警告', () => {
  const result = validatePair('Open Factory now', '现在打开', 'k');
  assert.ok(result.warnings.some((warning) => warning.includes('Factory')));
});

test('纯产品名相同不产生未翻译警告', () => {
  const result = validatePair('Factory', 'Factory', 'k');
  assert.deepEqual(result.warnings, []);
});

test('占位符解析支持多个与嵌套花括号', () => {
  assert.deepEqual(
    [...placeholders('{{count}} / {{name}} / {{a.b}}')].sort(),
    ['{{a.b}}', '{{count}}', '{{name}}'],
  );
});

test('复数分组识别', () => {
  const groups = splitPluralGroups({ a_one: 'x', a_other: 'y', b: 'z' });
  assert.equal(groups.size, 1);
  assert.equal(groups.get('a').length, 2);
});

test('HTML 标签必须逐字对应', () => {
  const ok = validatePair(
    'Read <settingsLink>settings</settingsLink> now',
    '现在阅读<settingsLink>设置</settingsLink>',
    'k',
  );
  assert.deepEqual(ok.errors, []);
});

test('标签缺失或改名必须报错', () => {
  const missing = validatePair(
    'Read <settingsLink>settings</settingsLink>',
    '阅读设置',
    'k',
  );
  assert.equal(missing.errors.length, 1);
  assert.match(missing.errors[0], /标签不一致/);

  const renamed = validatePair(
    'Read <settingsLink>settings</settingsLink>',
    '阅读<settings>设置</settings>',
    'k',
  );
  assert.equal(renamed.errors.length, 1);
});