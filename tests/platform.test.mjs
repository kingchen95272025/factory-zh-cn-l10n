import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspectLayout, defaultStateRoot } from '../scripts/lib/app.mjs';

function tempDir() {
  return mkdtempSync(path.join(os.tmpdir(), 'factory-l10n-test-'));
}

test('识别 macOS .app 布局', () => {
  const root = tempDir();
  try {
    const resources = path.join(root, 'Factory.app/Contents/Resources');
    mkdirSync(resources, { recursive: true });
    writeFileSync(path.join(resources, 'app.asar'), '');
    const layout = inspectLayout(path.join(root, 'Factory.app'));
    assert.equal(layout.layout, 'mac');
    assert.equal(layout.platform, 'darwin');
    assert.equal(layout.asarPath, path.join(resources, 'app.asar'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('识别 resources/app.asar 安装目录', () => {
  const root = tempDir();
  try {
    const resources = path.join(root, 'Factory/resources');
    mkdirSync(resources, { recursive: true });
    writeFileSync(path.join(resources, 'app.asar'), '');
    const layout = inspectLayout(path.join(root, 'Factory'));
    assert.equal(layout.layout, 'dir');
    assert.equal(layout.asarPath, path.join(resources, 'app.asar'));
    assert.equal(layout.plistPath, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('识别直接传入 resources 目录或 asar 文件', () => {
  const root = tempDir();
  try {
    const resources = path.join(root, 'Factory/resources');
    mkdirSync(resources, { recursive: true });
    writeFileSync(path.join(resources, 'app.asar'), '');
    assert.equal(inspectLayout(resources).layout, 'resources');
    assert.equal(inspectLayout(path.join(resources, 'app.asar')).layout, 'asar');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('无效目录抛出明确错误', () => {
  const root = tempDir();
  try {
    assert.throws(() => inspectLayout(root), /不是有效的 Factory 应用目录/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('默认状态目录按平台存在', () => {
  const stateRoot = defaultStateRoot();
  assert.ok(stateRoot.length > 0);
  assert.ok(stateRoot.includes('factory-l10n'));
});