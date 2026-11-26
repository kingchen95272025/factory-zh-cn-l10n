import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import {
  createResolver,
  findRendererCatalog,
  findRendererLanguageList,
  findRendererLoaderMap,
  findMainDesktopMap,
  parseBundle,
} from './ast.mjs';

export function locateRendererEntry(extractDir) {
  const htmlPath = path.join(extractDir, '.vite/renderer/main_window/index.html');
  if (!existsSync(htmlPath)) throw new Error(`未找到渲染层入口：${htmlPath}`);
  const html = readFileSync(htmlPath, 'utf8');
  const match = html.match(/src="\.?\/?([^"]*index-[A-Za-z0-9_-]+\.js)"/);
  if (!match) throw new Error('index.html 中未找到应用入口 bundle');
  const entryPath = path.join(extractDir, '.vite/renderer/main_window', match[1]);
  if (!existsSync(entryPath)) throw new Error(`入口 bundle 不存在：${entryPath}`);
  return entryPath;
}

export function locateMainBundle(extractDir) {
  const buildDir = path.join(extractDir, '.vite/build');
  const candidates = readdirSync(buildDir)
    .filter((name) => name.endsWith('.js'))
    .map((name) => path.join(buildDir, name))
    .filter((filePath) => statSync(filePath).size > 200_000);
  for (const filePath of candidates) {
    const source = readFileSync(filePath, 'utf8');
    if (source.includes('ChineseSimplified="zh-CN"') && source.includes('loadLanguages')) {
      return filePath;
    }
  }
  throw new Error('未找到包含主进程 i18n 资源的 bundle');
}

export function extractRendererCatalog(entryPath) {
  const source = readFileSync(entryPath, 'utf8');
  const ast = parseBundle(source, entryPath);
  const catalog = findRendererCatalog(ast, source);
  const resolver = createResolver(source, ast);
  const namespaces = {};
  for (const [name, node] of catalog.namespaceProps) {
    namespaces[name] = resolver.resolve(node, `epn.${name}`);
  }
  const languageList = findRendererLanguageList(ast);
  const loaderMap = findRendererLoaderMap(ast);
  const loaderEntries = loaderMap.properties.map((property) => {
    const language = property.key.property?.name ?? 'unknown';
    let importSource = null;
    let importRange = null;
    const visit = (node) => {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'ImportExpression' && node.source.type === 'Literal') {
        importSource = node.source.value;
        importRange = [node.source.start, node.source.end];
      }
      for (const [key, value] of Object.entries(node)) {
        if (key === 'start' || key === 'end' || key === 'type') continue;
        if (Array.isArray(value)) value.forEach(visit);
        else if (value && typeof value.type === 'string') visit(value);
      }
    };
    visit(property.value);
    return {
      language,
      importSource,
      importRange,
      propertyRange: [property.start, property.end],
      keyRange: [property.key.start, property.key.end],
    };
  });
  return {
    source,
    namespaces,
    resolverErrors: resolver.errors,
    anchors: {
      languageListVariable: languageList.name,
      languageListRange: [languageList.node.start, languageList.node.end],
      languageListValues: languageList.node.elements.map(
        (element) => element.property?.name ?? element.name ?? null,
      ),
      enumName: loaderMap.properties[0].key.object.name,
      loaderMapRange: [loaderMap.node.start, loaderMap.node.end],
      loaderEntries,
    },
  };
}

export function extractMainCatalog(bundlePath) {
  const source = readFileSync(bundlePath, 'utf8');
  const ast = parseBundle(source, bundlePath);
  const map = findMainDesktopMap(ast);
  const resolver = createResolver(source, ast);
  const resolved = resolver.resolve(map.englishNode, 'KF.English');
  const desktop = resolved?.desktop;
  if (!desktop) throw new Error('主进程英文资源缺少 desktop 命名空间');
  return {
    source,
    desktop,
    resolverErrors: resolver.errors,
    anchors: {
      resourceMapRange: [map.node.start, map.node.end],
      enumName: map.enumName,
      languages: map.properties.map((property) => property.key.property?.name ?? null),
    },
  };
}

export function countStrings(value) {
  if (typeof value === 'string') return 1;
  if (Array.isArray(value)) return value.reduce((total, item) => total + countStrings(item), 0);
  if (value && typeof value === 'object') {
    return Object.values(value).reduce((total, item) => total + countStrings(item), 0);
  }
  return 0;
}

export function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    const sorted = {};
    for (const key of Object.keys(value).sort()) sorted[key] = sortDeep(value[key]);
    return sorted;
  }
  return value;
}

export function writeNamespaceFiles(baseDir, namespaces) {
  const manifest = {};
  for (const [name, value] of Object.entries(namespaces)) {
    const sorted = sortDeep(value);
    const filePath = path.join(baseDir, `${name}.json`);
    writeJson(filePath, sorted);
    manifest[name] = { file: `${name}.json`, strings: countStrings(sorted) };
  }
  return manifest;
}

export function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}