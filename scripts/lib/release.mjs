import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

export const CATALOG_ROOT = path.resolve('catalog');
export const TRANSLATION_ROOT = path.resolve('translations');

function compareVersions(left, right) {
  const parse = (value) => value.split(/[.-]/).map((part) => Number(part) || 0);
  const a = parse(left);
  const b = parse(right);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const diff = (b[i] ?? 0) - (a[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function listReleases() {
  if (!existsSync(CATALOG_ROOT)) return [];
  return readdirSync(CATALOG_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort(compareVersions);
}

export function resolveRelease(explicit) {
  if (explicit) {
    const dir = path.join(CATALOG_ROOT, explicit);
    if (!existsSync(path.join(dir, 'manifest.json'))) {
      throw new Error(`未找到版本 ${explicit} 的英文目录：${dir}`);
    }
    return explicit;
  }
  const releases = listReleases();
  if (!releases.length) {
    throw new Error('catalog 下没有任何版本，请先运行 npm run extract');
  }
  return releases[0];
}

export function loadManifest(releaseId) {
  return JSON.parse(readFileSync(path.join(CATALOG_ROOT, releaseId, 'manifest.json'), 'utf8'));
}

export function loadNamespaceDir(dir) {
  if (!existsSync(dir)) return {};
  const result = {};
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    result[name.slice(0, -5)] = JSON.parse(readFileSync(path.join(dir, name), 'utf8'));
  }
  return result;
}

export function loadSourceCatalog(releaseId) {
  const base = path.join(CATALOG_ROOT, releaseId);
  return {
    renderer: loadNamespaceDir(path.join(base, 'renderer/en')),
    main: loadNamespaceDir(path.join(base, 'main/en/desktop')),
  };
}

export function loadTranslations(lang = 'zh-CN') {
  const base = path.join(TRANSLATION_ROOT, lang);
  return {
    renderer: loadNamespaceDir(path.join(base, 'renderer')),
    main: loadNamespaceDir(path.join(base, 'main/desktop')),
  };
}

export function translationPaths(lang = 'zh-CN') {
  const base = path.join(TRANSLATION_ROOT, lang);
  return {
    renderer: path.join(base, 'renderer'),
    main: path.join(base, 'main/desktop'),
  };
}