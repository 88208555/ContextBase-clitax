import { dirname, extname, relative, resolve } from 'node:path'
import { ContextCache } from './contextbase-cache.mjs'
import {
  CONTEXTBASE_SCHEMA,
  SOURCE_EXTENSIONS,
  fail,
  projectFile,
  projectSourceFiles,
  repositoryRoot,
  safeRelativePath,
} from './contextbase-fs.mjs'
import {
  buildProjectMap,
  getProjectMap,
  mapStorageBytes,
} from './contextbase-map.mjs'
import {
  TYPESCRIPT_ADAPTER,
  directDependencies,
  findDefinition,
  isSupportedPath,
  sourceAnalysis,
  symbolReferences,
} from './contextbase-typescript.mjs'

const OPERATION_SCHEMAS = Object.freeze({
  capabilities: { type: 'object', additionalProperties: false },
  help: { type: 'object', additionalProperties: false },
  'map-build': {
    type: 'object', additionalProperties: false,
    properties: { chainId: { type: 'string', minLength: 1 } },
  },
  'map-get': { type: 'object', additionalProperties: false },
  'file-read': {
    type: 'object', additionalProperties: false, required: ['path'],
    properties: { path: { type: 'string', minLength: 1 }, chainId: { type: 'string', minLength: 1 } },
  },
  'symbol-read': {
    type: 'object', additionalProperties: false, required: ['path', 'symbol', 'dependencyDepth'],
    properties: {
      path: { type: 'string', minLength: 1 },
      symbol: { type: 'string', minLength: 1 },
      dependencyDepth: { type: 'integer', minimum: 0, maximum: 2 },
      chainId: { type: 'string', minLength: 1 },
    },
  },
  'refs-read': {
    type: 'object', additionalProperties: false, required: ['path', 'symbol'],
    properties: {
      path: { type: 'string', minLength: 1 }, symbol: { type: 'string', minLength: 1 },
      chainId: { type: 'string', minLength: 1 },
    },
  },
  'cache-stats': { type: 'object', additionalProperties: false },
  'budget-report': {
    type: 'object', additionalProperties: false, required: ['chainId'],
    properties: { chainId: { type: 'string', minLength: 1 } },
  },
  invalidate: {
    type: 'object', additionalProperties: false, required: ['path'],
    properties: { path: { type: 'string', minLength: 1 } },
  },
  'context-pack': {
    type: 'object', additionalProperties: false, required: ['symbols', 'dependencyDepth'],
    properties: {
      symbols: { type: 'array', minItems: 1, items: {
        type: 'object', additionalProperties: false, required: ['path', 'symbol'],
        properties: { path: { type: 'string', minLength: 1 }, symbol: { type: 'string', minLength: 1 } },
      } },
      dependencyDepth: { type: 'integer', minimum: 0, maximum: 2 },
      chainId: { type: 'string', minLength: 1 },
    },
  },
})
const OPERATIONS = Object.freeze(Object.keys(OPERATION_SCHEMAS))

function objectInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('CONTEXTBASE_INPUT_INVALID', 'input must be an object')
  }
  return value
}

function validateInput(value, schema, path = 'input') {
  const invalid = (message) => fail('CONTEXTBASE_INPUT_INVALID', path + ' ' + message)
  if (schema.type === 'object') {
    objectInput(value)
    const properties = schema.properties ?? {}
    for (const name of schema.required ?? []) {
      if (!Object.hasOwn(value, name)) invalid('requires ' + name)
    }
    for (const [name, item] of Object.entries(value)) {
      if (!Object.hasOwn(properties, name)) invalid('contains unsupported field ' + name)
      validateInput(item, properties[name], path + '.' + name)
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length < schema.minItems) invalid('must be a non-empty array')
    value.forEach((item, index) => validateInput(item, schema.items, path + '[' + index + ']'))
  } else if (schema.type === 'string') {
    if (typeof value !== 'string' || value.trim().length < schema.minLength) invalid('must be a non-empty string')
  } else if (schema.type === 'integer') {
    if (!Number.isInteger(value) || value < schema.minimum || value > schema.maximum) invalid('is outside its integer range')
  } else invalid('uses an unsupported schema type')
}

function requiredString(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    fail('CONTEXTBASE_INPUT_INVALID', `${field} is required`)
  }
  return value.trim()
}

function dependencyDepth(value) {
  if (!Number.isInteger(value) || value < 0 || value > 2) {
    fail('CONTEXTBASE_DEPTH_INVALID', 'dependencyDepth must be an integer from 0 to 2')
  }
  return value
}

async function existingCandidate(root, candidates) {
  for (const path of candidates) {
    try {
      return (await projectFile(root, path)).path
    } catch (error) {
      if (!(error instanceof Error && error.code === 'ENOENT')) throw error
    }
  }
  return null
}

async function resolveRelativeModule(root, importer, specifier) {
  if (!specifier.startsWith('.')) return null
  const baseAbsolute = resolve(root, dirname(importer), specifier)
  const base = relative(root, baseAbsolute).split('\\').join('/')
  if (base === '..' || base.startsWith('../')) return null
  const suffixless = extname(base) ? base.slice(0, -extname(base).length) : base
  const candidates = [base]
  for (const extension of SOURCE_EXTENSIONS) {
    candidates.push(`${suffixless}${extension}`, `${base}/index${extension}`)
  }
  return existingCandidate(root, [...new Set(candidates)])
}

async function importClosure(root, cache, startPath, chainId, maxDepth) {
  const sources = new Map()
  const queue = [{ path: safeRelativePath(startPath), depth: 0 }]
  while (queue.length) {
    const current = queue.shift()
    if (sources.has(current.path)) continue
    const source = await cache.source(current.path, { chainId })
    sources.set(current.path, source)
    if (current.depth >= maxDepth || !isSupportedPath(current.path)) continue
    const analysis = sourceAnalysis(current.path, source.content)
    for (const item of analysis.imports) {
      const imported = await resolveRelativeModule(root, current.path, item.module)
      if (imported && !sources.has(imported)) queue.push({ path: imported, depth: current.depth + 1 })
    }
  }
  return sources
}

async function symbolResult(root, cache, input) {
  const path = safeRelativePath(requiredString(input.path, 'path'))
  const symbol = requiredString(input.symbol, 'symbol')
  const depth = dependencyDepth(input.dependencyDepth)
  const chainId = input.chainId ? requiredString(input.chainId, 'chainId') : undefined
  if (!isSupportedPath(path)) {
    fail('CONTEXTBASE_ADAPTER_REQUIRED', 'symbol-read requires the TS/JS adapter; request file-read explicitly for whole-file content')
  }
  const target = await cache.source(path, { chainId })
  const sources = await importClosure(root, cache, path, chainId, depth + 1)
  const targetAnalysis = sourceAnalysis(path, target.content)
  const definition = findDefinition(targetAnalysis, symbol)
  const dependencies = []
  const seen = new Set([`${path}:${definition.name}`])
  let frontier = [{ path, symbol: definition.name }]
  for (let level = 0; level < depth; level += 1) {
    const next = []
    for (const item of frontier) {
      const result = directDependencies(root, sources, item.path, item.symbol)
      for (const dependency of result.dependencies) {
        const key = `${dependency.path}:${dependency.definition.name}`
        if (seen.has(key)) continue
        seen.add(key)
        dependencies.push({ depth: level + 1, path: dependency.path, ...dependency.definition })
        next.push({ path: dependency.path, symbol: dependency.definition.name })
      }
    }
    frontier = next
  }
  return {
    schemaVersion: CONTEXTBASE_SCHEMA,
    mode: 'symbol',
    adapter: TYPESCRIPT_ADAPTER,
    path,
    hash: target.hash,
    definition,
    dependencies,
    suppliedLines: definition.endLine - definition.startLine + 1
      + dependencies.reduce((sum, item) => sum + item.endLine - item.startLine + 1, 0),
  }
}

async function fileResult(cache, input) {
  const source = await cache.source(input.path, { chainId: input.chainId })
  return { schemaVersion: CONTEXTBASE_SCHEMA, mode: 'whole-file', path: source.path,
    hash: source.hash, content: source.content, budgeted: Boolean(input.chainId) }
}

async function referenceCandidates(root) {
  const mapped = await getProjectMap(root)
  if (mapped.available && mapped.stale) {
    fail('CONTEXTBASE_MAP_STALE', `project map is stale: ${mapped.stalePaths.join(', ')}`)
  }
  return mapped.available ? mapped.map.tree : projectSourceFiles(root)
}

async function refsResult(root, cache, input) {
  const path = safeRelativePath(requiredString(input.path, 'path'))
  const symbol = requiredString(input.symbol, 'symbol')
  const chainId = input.chainId ? requiredString(input.chainId, 'chainId') : undefined
  if (!isSupportedPath(path)) {
    fail('CONTEXTBASE_ADAPTER_REQUIRED', 'refs-read requires the TS/JS language adapter')
  }
  const sources = new Map()
  for (const candidate of await referenceCandidates(root)) {
    if (!isSupportedPath(candidate)) continue
    const source = await cache.source(candidate, { chainId })
    sources.set(candidate, source)
  }
  return {
    schemaVersion: CONTEXTBASE_SCHEMA,
    adapter: TYPESCRIPT_ADAPTER,
    path,
    symbol,
    references: symbolReferences(root, sources, path, symbol, 3),
    scannedFiles: sources.size,
  }
}

async function contextPack(root, cache, input) {
  if (!Array.isArray(input.symbols) || input.symbols.length === 0) {
    fail('CONTEXTBASE_SYMBOLS_REQUIRED', 'symbols must be a non-empty array')
  }
  const depth = dependencyDepth(input.dependencyDepth)
  const items = []
  for (const value of input.symbols) {
    const symbol = objectInput(value)
    items.push(await symbolResult(root, cache, {
      path: symbol.path,
      symbol: symbol.symbol,
      dependencyDepth: depth,
      chainId: input.chainId,
    }))
  }
  return { schemaVersion: CONTEXTBASE_SCHEMA, mode: 'swarm-context-pack', items,
    cache: cache.cacheStats() }
}

async function createContextBaseService(repositoryRootValue) {
  const root = await repositoryRoot(repositoryRootValue)
  const cache = await new ContextCache(root).initialize()
  return {
    root,
    async execute(operationValue, inputValue) {
      const operation = requiredString(operationValue, 'operation')
      const input = objectInput(inputValue)
      if (!OPERATIONS.includes(operation)) fail('CONTEXTBASE_OPERATION_UNKNOWN', `${operation} is unsupported`)
      validateInput(input, OPERATION_SCHEMAS[operation])
      if (operation === 'capabilities') return {
        schemaVersion: CONTEXTBASE_SCHEMA,
        operations: OPERATIONS,
        operationSchemas: OPERATION_SCHEMAS,
        adapters: [{ language: 'typescript-javascript', status: 'installed', adapter: TYPESCRIPT_ADAPTER }],
        unsupportedLanguagePolicy: 'adapter-required-or-explicit-budgeted-file-read',
        sharedCacheBoundary: 'One long-lived broker process shares verified memory cache across clients.',
      }
      if (operation === 'help') return { schemaVersion: CONTEXTBASE_SCHEMA,
        operations: OPERATIONS, operationSchemas: OPERATION_SCHEMAS }
      if (operation === 'map-build') return buildProjectMap(root, cache, input)
      if (operation === 'map-get') return getProjectMap(root)
      if (operation === 'file-read') return fileResult(cache, input)
      if (operation === 'symbol-read') return symbolResult(root, cache, input)
      if (operation === 'refs-read') return refsResult(root, cache, input)
      if (operation === 'cache-stats') return { ...cache.cacheStats(),
        mapBytes: await mapStorageBytes(root) }
      if (operation === 'budget-report') {
        return cache.budgetReport(requiredString(input.chainId, 'chainId'))
      }
      if (operation === 'invalidate') return cache.invalidate(requiredString(input.path, 'path'))
      return contextPack(root, cache, input)
    },
  }
}

export {
  OPERATIONS,
  OPERATION_SCHEMAS,
  createContextBaseService,
}
