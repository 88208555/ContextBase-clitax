import { isAbsolute, relative, resolve } from 'node:path'
import ts from 'typescript-language-service'
import { fail, safeRelativePath } from './contextbase-fs.mjs'

const TYPESCRIPT_ADAPTER = 'typescript-language-service/1.0'
const SUPPORTED_EXTENSIONS = /\.(?:cjs|js|jsx|mjs|ts|tsx)$/

function isSupportedPath(path) {
  return SUPPORTED_EXTENSIONS.test(path)
}

function scriptKind(path) {
  if (path.endsWith('.tsx')) return ts.ScriptKind.TSX
  if (path.endsWith('.jsx')) return ts.ScriptKind.JSX
  if (path.endsWith('.js') || path.endsWith('.mjs') || path.endsWith('.cjs')) {
    return ts.ScriptKind.JS
  }
  return ts.ScriptKind.TS
}

function parseSource(path, content) {
  return ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true, scriptKind(path))
}

function declarationName(node) {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) return node.name.text
  const name = node.name
  if (name && (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name))) {
    return name.text
  }
  return null
}

function declarationNode(node) {
  return ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)
    || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)
    || ts.isEnumDeclaration(node) || ts.isMethodDeclaration(node)
    || ts.isPropertyDeclaration(node) || ts.isVariableDeclaration(node)
}

function qualifiedName(node) {
  const own = declarationName(node)
  if (!own) return null
  let parent = node.parent
  while (parent) {
    if (ts.isClassDeclaration(parent) || ts.isInterfaceDeclaration(parent)) {
      const name = declarationName(parent)
      return name ? `${name}.${own}` : own
    }
    parent = parent.parent
  }
  return own
}

function modifierOwner(node) {
  if (!ts.isVariableDeclaration(node)) return node
  const statement = node.parent?.parent
  return statement && ts.isVariableStatement(statement) ? statement : node
}

function isExported(node) {
  const owner = modifierOwner(node)
  if (!ts.canHaveModifiers(owner)) return false
  return (ts.getModifiers(owner) ?? []).some((modifier) => (
    modifier.kind === ts.SyntaxKind.ExportKeyword || modifier.kind === ts.SyntaxKind.DefaultKeyword
  ))
}

function declarationRecord(source, node) {
  const name = qualifiedName(node)
  if (!name) return null
  const start = node.getStart(source)
  const end = node.getEnd()
  const nameStart = node.name?.getStart(source) ?? start
  const startPosition = source.getLineAndCharacterOfPosition(start)
  const endPosition = source.getLineAndCharacterOfPosition(end)
  return {
    name,
    kind: ts.SyntaxKind[node.kind],
    exported: isExported(node),
    start,
    end,
    nameStart,
    startLine: startPosition.line + 1,
    startColumn: startPosition.character + 1,
    endLine: endPosition.line + 1,
    endColumn: endPosition.character + 1,
    content: source.text.slice(start, end),
  }
}

function declarations(source) {
  const records = []
  function visit(node) {
    if (declarationNode(node)) {
      const record = declarationRecord(source, node)
      if (record) records.push(record)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return records
}

function imports(source) {
  const records = []
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue
    const module = statement.moduleSpecifier.text
    const clause = statement.importClause
    if (clause?.name) records.push({ local: clause.name.text, imported: 'default', module })
    const bindings = clause?.namedBindings
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        records.push({
          local: element.name.text,
          imported: element.propertyName?.text ?? element.name.text,
          module,
        })
      }
    }
    if (bindings && ts.isNamespaceImport(bindings)) {
      records.push({ local: bindings.name.text, imported: '*', module })
    }
  }
  return records
}

function callPositions(source, definition) {
  const positions = []
  function visit(node) {
    if (node.getStart(source) < definition.start || node.getEnd() > definition.end) {
      ts.forEachChild(node, visit)
      return
    }
    if (ts.isCallExpression(node)) positions.push(node.expression.getStart(source))
    ts.forEachChild(node, visit)
  }
  visit(source)
  return positions
}

function sourceAnalysis(path, content) {
  if (!isSupportedPath(path)) return null
  const source = parseSource(path, content)
  return {
    adapter: TYPESCRIPT_ADAPTER,
    path,
    declarations: declarations(source),
    imports: imports(source),
    source,
  }
}

function findDefinition(analysis, symbol) {
  const exact = analysis.declarations.find((item) => item.name === symbol)
  if (exact) return exact
  const matches = analysis.declarations.filter((item) => item.name.split('.').at(-1) === symbol)
  if (matches.length === 1) return matches[0]
  if (matches.length > 1) fail('CONTEXTBASE_SYMBOL_AMBIGUOUS', `${symbol} has multiple definitions`)
  fail('CONTEXTBASE_SYMBOL_NOT_FOUND', `${symbol} was not found in ${analysis.path}`)
}

function projectAbsolute(root, path) {
  return resolve(root, ...safeRelativePath(path).split('/'))
}

function sourceFromAbsolute(root, sources, fileName) {
  const projectPath = relative(root, fileName).split('\\').join('/')
  return sources.get(projectPath)
}

function languageService(root, sources) {
  const fileNames = [...sources.keys()].map((path) => projectAbsolute(root, path))
  const options = {
    allowJs: true,
    checkJs: false,
    jsx: ts.JsxEmit.Preserve,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022,
  }
  const insideRoot = (fileName) => {
    const path = relative(root, fileName)
    return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith('../'))
  }
  const host = {
    getCompilationSettings: () => options,
    getCurrentDirectory: () => root,
    getDefaultLibFileName: (settings) => ts.getDefaultLibFilePath(settings),
    getScriptFileNames: () => fileNames,
    getScriptVersion: (fileName) => sourceFromAbsolute(root, sources, fileName)?.hash ?? '0',
    getScriptSnapshot(fileName) {
      const source = sourceFromAbsolute(root, sources, fileName)
      if (source) return ts.ScriptSnapshot.fromString(source.content)
      if (insideRoot(fileName)) return undefined
      const content = ts.sys.readFile(fileName)
      return content === undefined ? undefined : ts.ScriptSnapshot.fromString(content)
    },
    fileExists(fileName) {
      return insideRoot(fileName) ? Boolean(sourceFromAbsolute(root, sources, fileName))
        : ts.sys.fileExists(fileName)
    },
    readFile(fileName) {
      return insideRoot(fileName) ? sourceFromAbsolute(root, sources, fileName)?.content
        : ts.sys.readFile(fileName)
    },
    readDirectory: ts.sys.readDirectory,
  }
  return ts.createLanguageService(host, ts.createDocumentRegistry())
}

function containingDefinition(analysis, position) {
  const candidates = analysis.declarations.filter((item) => item.start <= position && item.end >= position)
  return candidates.sort((left, right) => (left.end - left.start) - (right.end - right.start))[0]
}

function directDependencies(root, sources, targetPath, symbol) {
  const target = sources.get(targetPath)
  const analysis = sourceAnalysis(targetPath, target.content)
  const definition = findDefinition(analysis, symbol)
  const service = languageService(root, sources)
  const targetFile = projectAbsolute(root, targetPath)
  const found = new Map()
  for (const position of callPositions(analysis.source, definition)) {
    for (const item of service.getDefinitionAtPosition(targetFile, position) ?? []) {
      const projectPath = relative(root, item.fileName).split('\\').join('/')
      const source = sources.get(projectPath)
      if (!source) continue
      const dependencyAnalysis = sourceAnalysis(projectPath, source.content)
      const dependency = containingDefinition(dependencyAnalysis, item.textSpan.start)
      if (!dependency || (projectPath === targetPath && dependency.name === definition.name)) continue
      found.set(`${projectPath}:${dependency.name}`, { path: projectPath, definition: dependency })
    }
  }
  service.dispose()
  return { definition, dependencies: [...found.values()] }
}

function contextWindow(content, position, contextLines) {
  const lines = content.split('\n')
  const prefix = content.slice(0, position)
  const line = prefix.split('\n').length - 1
  const column = position - (prefix.lastIndexOf('\n') + 1)
  const start = Math.max(0, line - contextLines)
  const end = Math.min(lines.length, line + contextLines + 1)
  return { line: line + 1, column: column + 1, context: lines.slice(start, end).join('\n') }
}

function symbolReferences(root, sources, targetPath, symbol, contextLines) {
  const target = sources.get(targetPath)
  const analysis = sourceAnalysis(targetPath, target.content)
  const definition = findDefinition(analysis, symbol)
  const service = languageService(root, sources)
  const groups = service.findReferences(projectAbsolute(root, targetPath), definition.nameStart) ?? []
  const references = []
  for (const group of groups) {
    references.push({ ...group.definition, isDefinition: true })
    references.push(...group.references)
  }
  service.dispose()
  const unique = new Map()
  for (const reference of references) {
    const path = relative(root, reference.fileName).split('\\').join('/')
    const source = sources.get(path)
    if (!source) continue
    const key = `${path}:${reference.textSpan.start}:${reference.textSpan.length}`
    unique.set(key, {
      path,
      ...contextWindow(source.content, reference.textSpan.start, contextLines),
      isDefinition: reference.isDefinition === true,
    })
  }
  return [...unique.values()]
}

export {
  TYPESCRIPT_ADAPTER,
  directDependencies,
  findDefinition,
  isSupportedPath,
  sourceAnalysis,
  symbolReferences,
}
