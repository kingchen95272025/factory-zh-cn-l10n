import {
  findDeclaratorForInit,
  findRendererLanguageList,
  findRendererLoaderMap,
  findMainDesktopMap,
  findMainSupportedList,
  findStatementContaining,
  hasChineseEnum,
  parseBundle,
  walkAst,
} from './ast.mjs';
import { sha256Text } from './app.mjs';

function findImportLiteral(property) {
  let literal = null;
  walkAst(property.value, (node) => {
    if (node.type === 'ImportExpression' && node.source.type === 'Literal') {
      literal = node.source;
    }
  });
  return literal;
}

function applyEdits(source, edits) {
  const sorted = [...edits].sort((left, right) => right.at - left.at);
  let result = source;
  let lastAt = Number.POSITIVE_INFINITY;
  for (const edit of sorted) {
    if (edit.at > lastAt) throw new Error('补丁插入点重叠，已中止');
    lastAt = edit.at;
    result = result.slice(0, edit.at) + edit.text + result.slice(edit.at);
  }
  return result;
}

function appendMember(source, closingIndex, member) {
  const before = source.slice(0, closingIndex).trimEnd();
  const endsWithSeparator = /[,\[{]$/.test(before);
  return `${endsWithSeparator ? '' : ','}${member}`;
}

export function buildResourceChunk(resources) {
  const json = JSON.stringify(resources);
  const content = `const resources=${json};export{resources};\n`;
  const hash = sha256Text(content).slice(0, 8);
  return { content, hash, filename: `resources-zhCN-${hash}.js` };
}

export function planRendererPatch(source) {
  const ast = parseBundle(source, 'renderer');
  if (!hasChineseEnum(ast)) {
    throw new Error('语言枚举中不存在 ChineseSimplified="zh-CN"，补丁锚点不匹配');
  }
  const languageList = findRendererLanguageList(ast);
  const loaderMap = findRendererLoaderMap(ast);
  const values = languageList.node.elements.map(
    (element) => element.property?.name ?? element.name ?? null,
  );
  const enumName = loaderMap.properties[0].key.object.name;
  const languagePresent = values.includes('ChineseSimplified');
  const loaderPresent = loaderMap.properties.some(
    (property) => property.key.property?.name === 'ChineseSimplified',
  );
  return {
    ast,
    languageList,
    loaderMap,
    values,
    enumName,
    languagePresent,
    loaderPresent,
    alreadyPatched: languagePresent && loaderPresent,
  };
}

export function patchRenderer(source, resources) {
  const plan = planRendererPatch(source);
  const chunk = buildResourceChunk(resources);
  if (plan.alreadyPatched) {
    return { source, chunk, alreadyPatched: true, enumName: plan.enumName, languageList: plan.values };
  }

  const { languageList, loaderMap, enumName, languagePresent, loaderPresent } = plan;
  const japanese = loaderMap.properties.find(
    (property) => property.key.property?.name === 'Japanese',
  );
  if (!japanese) throw new Error('资源加载表中缺少 Japanese 条目，无法克隆');
  const importLiteral = findImportLiteral(japanese);
  if (!importLiteral) throw new Error('Japanese 资源条目中不存在动态 import');

  const propertyStart = japanese.start;
  const propertyText = source.slice(propertyStart, japanese.end);
  const keyStart = japanese.key.start - propertyStart;
  const keyEnd = japanese.key.end - propertyStart;
  const importStart = importLiteral.start - propertyStart;
  const importEnd = importLiteral.end - propertyStart;
  const importPath = `./${chunk.filename}`;

  const newProperty =
    propertyText.slice(0, keyStart) +
    `${enumName}.ChineseSimplified` +
    propertyText.slice(keyEnd, importStart) +
    JSON.stringify(importPath) +
    propertyText.slice(importEnd);

  if (source[languageList.node.end - 1] !== ']') {
    throw new Error('语言列表结尾不是 “]”，补丁锚点已变化');
  }
  if (source[loaderMap.node.end - 1] !== '}') {
    throw new Error('资源加载表结尾不是 “}”，补丁锚点已变化');
  }

  const edits = [];
  if (!languagePresent) {
    edits.push({
      at: languageList.node.end - 1,
      text: appendMember(source, languageList.node.end - 1, `${enumName}.ChineseSimplified`),
    });
  }
  if (!loaderPresent) {
    edits.push({
      at: loaderMap.node.end - 1,
      text: appendMember(source, loaderMap.node.end - 1, newProperty),
    });
  }
  const edited = applyEdits(source, edits);

  return {
    source: edited,
    chunk,
    alreadyPatched: false,
    enumName,
    languageList: languagePresent ? plan.values : [...plan.values, 'ChineseSimplified'],
    loaderProperty: loaderPresent ? null : newProperty,
  };
}

export function patchMain(source, desktopResources) {
  const ast = parseBundle(source, 'main');
  if (!hasChineseEnum(ast)) {
    throw new Error('主进程语言枚举中不存在 ChineseSimplified="zh-CN"，补丁锚点不匹配');
  }
  const map = findMainDesktopMap(ast);
  const supported = findMainSupportedList(ast);
  const languageAlreadyPresent = supported.values.some((value) => value.name === 'ChineseSimplified');
  const mapAlreadyPatched = map.properties.some(
    (property) => property.key.property?.name === 'ChineseSimplified',
  );
  if (mapAlreadyPatched && languageAlreadyPresent) {
    return {
      source,
      alreadyPatched: true,
      enumName: map.enumName,
      supportedList: supported.name,
    };
  }
  if (source[map.node.end - 1] !== '}') {
    throw new Error('主进程资源表结尾不是 “}”，补丁锚点已变化');
  }
  if (source[supported.node.end - 1] !== ']') {
    throw new Error('主进程语言白名单结尾不是 “]”，补丁锚点已变化');
  }
  const declarator = findDeclaratorForInit(ast, map.node);
  const statement = declarator ? findStatementContaining(ast, declarator) : null;
  if (!statement) throw new Error('无法定位主进程资源表所在语句');

  const variable = '__FACTORY_ZH_CN_DESKTOP__';
  if (source.includes(variable)) throw new Error(`主进程补丁变量 ${variable} 已存在`);

  const enumName = supported.values.find((value) => value.enumName)?.enumName ?? map.enumName;
  const edits = [];
  if (!mapAlreadyPatched) {
    edits.push({
      at: statement.start,
      text: `var ${variable}=${JSON.stringify(desktopResources)};\n`,
    });
    edits.push({
      at: map.node.end - 1,
      text: appendMember(
        source,
        map.node.end - 1,
        `[${map.enumName}.ChineseSimplified]:{desktop:${variable}}`,
      ),
    });
  }
  if (!languageAlreadyPresent) {
    edits.push({
      at: supported.node.end - 1,
      text: appendMember(source, supported.node.end - 1, `${enumName}.ChineseSimplified`),
    });
  }
  const edited = applyEdits(source, edits);

  return {
    source: edited,
    alreadyPatched: false,
    enumName: map.enumName,
    supportedList: supported.name,
    languages: languageAlreadyPresent
      ? supported.values.map((value) => value.name)
      : [...supported.values.map((value) => value.name), 'ChineseSimplified'],
    variable: mapAlreadyPatched ? null : variable,
  };
}