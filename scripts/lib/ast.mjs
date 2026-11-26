import { parse } from 'acorn';

const LANGUAGE_PROPS = [
  'English',
  'Italian',
  'Japanese',
  'ChineseSimplified',
  'Korean',
  'German',
  'Spanish',
  'Polish',
  'French',
];

export function parseBundle(source, label = '<bundle>') {
  try {
    return parse(source, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      allowHashBang: true,
      allowReturnOutsideFunction: true,
    });
  } catch (error) {
    if (error instanceof SyntaxError) {
      try {
        return parse(source, {
          ecmaVersion: 'latest',
          sourceType: 'script',
          allowHashBang: true,
          allowReturnOutsideFunction: true,
        });
      } catch {
        // 保留最初的模块解析错误，便于定位
      }
    }
    error.message = `${label}: ${error.message}`;
    throw error;
  }
}

export function walkAst(ast, visit) {
  const stack = [ast];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (typeof node.type === 'string') visit(node);
    for (const [key, value] of Object.entries(node)) {
      if (key === 'type' || key === 'start' || key === 'end' || key === 'loc' || key === 'range') {
        continue;
      }
      if (Array.isArray(value)) {
        for (const child of value) {
          if (child && typeof child.type === 'string') stack.push(child);
        }
      } else if (value && typeof value.type === 'string') {
        stack.push(value);
      }
    }
  }
}

export function buildDeclaratorMap(ast) {
  const map = new Map();
  walkAst(ast, (node) => {
    if (node.type !== 'VariableDeclarator') return;
    if (node.id.type !== 'Identifier' || !node.init) return;
    const list = map.get(node.id.name) ?? [];
    list.push(node);
    map.set(node.id.name, list);
  });
  return map;
}

function propertyKey(node) {
  if (!node.computed) {
    if (node.key.type === 'Identifier') return node.key.name;
    if (node.key.type === 'Literal') return String(node.key.value);
    return null;
  }
  if (node.key.type === 'Literal') return String(node.key.value);
  return null;
}

function memberName(node) {
  if (node?.type !== 'MemberExpression' || node.computed) return null;
  return node.property.type === 'Identifier' ? node.property.name : null;
}

function snippet(source, node) {
  return source.slice(node.start, Math.min(node.end, node.start + 100)).replace(/\s+/g, ' ');
}

export function createResolver(source, ast, options = {}) {
  const declarators = buildDeclaratorMap(ast);
  const cache = new WeakMap();
  const resolving = new Set();
  const errors = [];
  const maxErrors = options.maxErrors ?? 50;

  function fail(node, valuePath, detail) {
    if (errors.length < maxErrors) {
      errors.push({
        path: valuePath,
        type: node.type,
        detail,
        snippet: snippet(source, node),
      });
    }
    return undefined;
  }

  function resolveIdentifier(name, valuePath) {
    if (name === 'undefined') return undefined;
    if (name === 'NaN') return NaN;
    if (name === 'Infinity') return Infinity;
    const list = declarators.get(name);
    if (!list?.length) {
      return fail({ type: 'Identifier', start: 0, end: 0 }, valuePath, `无法解析标识符 ${name}`);
    }
    if (list.length > 1) {
      return fail(
        { type: 'Identifier', start: 0, end: 0 },
        valuePath,
        `标识符 ${name} 有 ${list.length} 处声明，无法安全解析`,
      );
    }
    return resolve(list[0].init, valuePath);
  }

  function resolveObject(node, valuePath, out) {
    for (const property of node.properties) {
      if (property.type === 'SpreadElement') {
        const spread = resolve(property.argument, `${valuePath}.*`);
        if (spread && typeof spread === 'object' && !Array.isArray(spread)) {
          Object.assign(out, spread);
        }
        continue;
      }
      if (property.type !== 'Property' || property.kind !== 'init' || property.method) {
        fail(property, valuePath, `不支持的对象属性类型：${property.type}/${property.kind}`);
        continue;
      }
      const key = propertyKey(property);
      if (key === null) {
        fail(property, valuePath, '不支持的动态计算属性名');
        continue;
      }
      const value = resolve(property.value, `${valuePath}.${key}`);
      if (value !== undefined) out[key] = value;
    }
    return out;
  }

  function resolve(node, valuePath) {
    if (cache.has(node)) return cache.get(node);
    if (resolving.has(node)) {
      fail(node, valuePath, '检测到循环引用');
      return undefined;
    }
    resolving.add(node);
    let result;
    switch (node.type) {
      case 'Literal':
        if (node.regex) {
          result = fail(node, valuePath, '不支持正则字面量');
        } else {
          result = node.value;
        }
        break;
      case 'Identifier':
        result = resolveIdentifier(node.name, valuePath);
        break;
      case 'ObjectExpression':
        result = resolveObject(node, valuePath, Object.create(null));
        break;
      case 'ArrayExpression':
        result = node.elements.map((element, index) => {
          if (!element) return null;
          if (element.type === 'SpreadElement') {
            const spread = resolve(element.argument, `${valuePath}.${index}`);
            return Array.isArray(spread) ? spread : [];
          }
          return resolve(element, `${valuePath}.${index}`);
        });
        result = result.flat();
        break;
      case 'TemplateLiteral':
        if (node.expressions.length === 0) {
          result = node.quasis[0].value.cooked;
        } else {
          result = fail(node, valuePath, '不支持含插值的模板字符串');
        }
        break;
      case 'UnaryExpression': {
        const argument = resolve(node.argument, valuePath);
        if (node.operator === 'void') result = undefined;
        else if (node.operator === '-') result = -argument;
        else if (node.operator === '+') result = +argument;
        else if (node.operator === '!') result = !argument;
        else result = fail(node, valuePath, `不支持的一元运算符 ${node.operator}`);
        break;
      }
      case 'BinaryExpression': {
        const left = resolve(node.left, `${valuePath}.left`);
        const right = resolve(node.right, `${valuePath}.right`);
        if (node.operator === '+') result = left + right;
        else result = fail(node, valuePath, `不支持的二元运算符 ${node.operator}`);
        break;
      }
      case 'LogicalExpression': {
        const left = resolve(node.left, `${valuePath}.left`);
        if (node.operator === '||') result = left || resolve(node.right, `${valuePath}.right`);
        else if (node.operator === '??') result = left ?? resolve(node.right, `${valuePath}.right`);
        else if (node.operator === '&&') result = left && resolve(node.right, `${valuePath}.right`);
        else result = fail(node, valuePath, `不支持的逻辑运算符 ${node.operator}`);
        break;
      }
      case 'ConditionalExpression': {
        const test = resolve(node.test, `${valuePath}.test`);
        result = test
          ? resolve(node.consequent, `${valuePath}.consequent`)
          : resolve(node.alternate, `${valuePath}.alternate`);
        break;
      }
      case 'SequenceExpression':
        result = resolve(node.expressions[node.expressions.length - 1], valuePath);
        break;
      case 'ParenthesizedExpression':
        result = resolve(node.expression, valuePath);
        break;
      case 'CallExpression': {
        const calleeName = memberName(node.callee);
        if (
          calleeName === 'parse' &&
          node.callee.object?.type === 'Identifier' &&
          node.callee.object.name === 'JSON' &&
          node.arguments.length === 1 &&
          node.arguments[0].type === 'Literal' &&
          typeof node.arguments[0].value === 'string'
        ) {
          result = JSON.parse(node.arguments[0].value);
        } else {
          result = fail(node, valuePath, '不支持函数调用表达式');
        }
        break;
      }
      default:
        result = fail(node, valuePath, `不支持的节点类型 ${node.type}`);
    }
    resolving.delete(node);
    cache.set(node, result);
    return result;
  }

  return {
    resolve: (node, valuePath = '$') => resolve(node, valuePath),
    errors,
  };
}

export function findProperty(objectNode, key) {
  return objectNode.properties.find((property) => {
    if (property.type !== 'Property') return false;
    return propertyKey(property) === key;
  });
}

export function findRendererCatalog(ast, source) {
  const assignCalls = [];
  const outerCalls = [];
  walkAst(ast, (node) => {
    if (node.type !== 'CallExpression') return;
    if (node.callee.type === 'MemberExpression' && memberName(node.callee) === 'assign') {
      const first = node.arguments[0];
      if (first?.type === 'ObjectExpression' && findProperty(first, './common.json')) {
        assignCalls.push(node);
      }
    }
  });
  if (assignCalls.length !== 1) {
    throw new Error(`未能唯一定位渲染层命名空间表（命中 ${assignCalls.length} 次）`);
  }
  const assignCall = assignCalls[0];
  walkAst(ast, (node) => {
    if (node.type !== 'CallExpression') return;
    const arg = node.arguments[0];
    if (arg?.type !== 'ObjectExpression') return;
    const hasSpread = arg.properties.some(
      (property) => property.type === 'SpreadElement' && property.argument === assignCall,
    );
    if (hasSpread && findProperty(arg, 'components')) outerCalls.push(node);
  });
  if (outerCalls.length !== 1) {
    throw new Error(`未能唯一定位渲染层资源合并调用（命中 ${outerCalls.length} 次）`);
  }
  const outerArg = outerCalls[0].arguments[0];
  const namespaceProps = new Map();
  for (const property of assignCall.arguments[0].properties) {
    const key = property.type === 'Property' ? propertyKey(property) : null;
    if (!key) continue;
    const name = key.replace(/^.*\//, '').replace(/\.json$/, '');
    namespaceProps.set(name, property.value);
  }
  const componentsProp = findProperty(outerArg, 'components');
  if (componentsProp) namespaceProps.set('components', componentsProp.value);
  return { namespaceProps, outerArg, assignCall, outerCall: outerCalls[0] };
}

export function findRendererLanguageList(ast) {
  let supportedProp = null;
  walkAst(ast, (node) => {
    if (node.type !== 'Property' || propertyKey(node) !== 'supportedLngs') return;
    if (node.value.type === 'ArrayExpression') supportedProp = node;
  });
  if (!supportedProp) {
    throw new Error('未能定位 supportedLngs 配置');
  }
  const spread = supportedProp.value.elements.find((element) => element?.type === 'SpreadElement');
  if (!spread || spread.argument.type !== 'Identifier') {
    throw new Error('supportedLngs 中未找到语言列表变量');
  }
  const name = spread.argument.name;
  let listNode = null;
  walkAst(ast, (node) => {
    if (node.type !== 'VariableDeclarator') return;
    if (node.id.type === 'Identifier' && node.id.name === name) {
      listNode = node.init;
    }
  });
  if (!listNode || listNode.type !== 'ArrayExpression') {
    throw new Error(`未能解析语言列表变量 ${name}`);
  }
  const values = listNode.elements.map(
    (element) => element?.property?.name ?? element?.name ?? null,
  );
  if (values.length < 5 || values.some((value) => !value)) {
    throw new Error(`语言列表 ${name} 结构异常：${JSON.stringify(values)}`);
  }
  return { name, node: listNode, supportedProp, values };
}

export function findRendererLoaderMap(ast) {
  const candidates = [];
  walkAst(ast, (node) => {
    if (node.type !== 'ObjectExpression') return;
    const properties = node.properties.filter((property) => property.type === 'Property');
    if (properties.length < 5) return;
    const languageKeys = properties
      .map((property) => (property.computed ? memberName(property.key) : null))
      .filter((key) => key && LANGUAGE_PROPS.includes(key));
    if (languageKeys.length < 5) return;
    const dynamicProps = properties.filter((property) => {
      if (property.value.type !== 'ArrowFunctionExpression') return false;
      let found = false;
      walkAst(property.value.body, (child) => {
        if (child.type === 'ImportExpression') found = true;
      });
      return found;
    });
    if (dynamicProps.length < 5) return;
    candidates.push({ node, properties, languageKeys });
  });
  if (candidates.length !== 1) {
    throw new Error(`未能唯一定位语言资源加载表（命中 ${candidates.length} 次）`);
  }
  return candidates[0];
}

export function findMainDesktopMap(ast) {
  const candidates = [];
  walkAst(ast, (node) => {
    if (node.type !== 'ObjectExpression') return;
    const properties = node.properties.filter((property) => property.type === 'Property');
    if (properties.length < 5 || properties.length > 12) return;
    const allComputedMembers = properties.every(
      (property) => property.computed && memberName(property.key),
    );
    if (!allComputedMembers) return;
    const withDesktop = properties.filter(
      (property) =>
        property.value.type === 'ObjectExpression' && Boolean(findProperty(property.value, 'desktop')),
    );
    if (withDesktop.length < 5) return;
    candidates.push({ node, properties });
  });
  if (candidates.length !== 1) {
    throw new Error(`未能唯一定位主进程资源表（命中 ${candidates.length} 次）`);
  }
  const { node, properties } = candidates[0];
  const englishProp = properties.find((property) => memberName(property.key) === 'English');
  if (!englishProp) throw new Error('主进程资源表缺少 English 条目');
  const enumName = englishProp.key.object?.name;
  if (!enumName) throw new Error('无法识别主进程语言枚举名');
  return { node, properties, enumName, englishNode: englishProp.value };
}

export function findMainSupportedList(ast) {
  const identifiers = new Set();
  walkAst(ast, (node) => {
    if (node.type !== 'ObjectExpression') return;
    const keys = new Set(
      node.properties
        .filter((property) => property.type === 'Property')
        .map((property) => propertyKey(property)),
    );
    if (!(keys.has('saved') && keys.has('candidates') && keys.has('supported'))) return;
    const property = findProperty(node, 'supported');
    if (property?.value.type === 'Identifier') {
      identifiers.add(property.value.name);
    }
  });
  if (identifiers.size !== 1) {
    throw new Error(`主进程 supported 白名单定位不唯一：${[...identifiers].join(', ') || '无'}`);
  }
  const supportedIdentifier = [...identifiers][0];

  let listNode = null;
  let declarator = null;
  walkAst(ast, (node) => {
    if (node.type !== 'VariableDeclarator') return;
    if (node.id.type === 'Identifier' && node.id.name === supportedIdentifier) {
      listNode = node.init;
      declarator = node;
    }
  });
  if (!listNode || listNode.type !== 'ArrayExpression') {
    throw new Error(`主进程 supported 白名单 ${supportedIdentifier} 不是数组`);
  }
  const values = listNode.elements.map((element) => ({
    name: element?.property?.name ?? element?.name ?? null,
    enumName: element?.object?.name ?? null,
  }));
  return { name: supportedIdentifier, node: listNode, declarator, values };
}

export function findStatementContaining(ast, targetNode) {
  let best = null;
  const visitStatement = (statement) => {
    if (!statement || targetNode.start < statement.start || targetNode.end > statement.end) return;
    best = statement;
    if (statement.type === 'BlockStatement') {
      for (const child of statement.body) visitStatement(child);
    } else if (statement.type === 'ExpressionStatement') {
      visitStatement(statement.expression);
    } else if (statement.type === 'VariableDeclaration') {
      for (const declaration of statement.declarations) {
        if (declaration.init) visitStatement(declaration.init);
      }
    }
  };
  for (const statement of ast.body) visitStatement(statement);
  return best;
}

export function findDeclaratorForInit(ast, initNode) {
  let found = null;
  walkAst(ast, (node) => {
    if (node.type === 'VariableDeclarator' && node.init === initNode) found = node;
  });
  return found;
}

export { LANGUAGE_PROPS };