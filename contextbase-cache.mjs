import { lstat, readFile } from 'node:fs/promises'
import {
  checkCachedReadAccess,
  readBudgetStatus,
  readFileWithinBudget,
} from 'cli-aimlock/local-runner'
import {
  CONTEXTBASE_SCHEMA,
  atomicJson,
  cacheKey,
  ensureManagedDirectory,
  managedPath,
  projectFile,
  readJsonIfExists,
  removeFileIfExists,
  safeRelativePath,
  sha256,
  statSignature,
  withFileLock,
} from './contextbase-fs.mjs'

const CACHE_SCHEMA = 'contextbase.cache-entry/1.0'
const INVALIDATION_SCHEMA = 'contextbase.invalidation/1.0'

async function fileStatusIfExists(path) {
  try {
    return await lstat(path)
  } catch (error) {
    if (error instanceof Error && error.code === 'ENOENT') return null
    throw error
  }
}

function initialStats() {
  return {
    memoryHits: 0,
    persistentHits: 0,
    misses: 0,
    diskReads: 0,
    invalidations: 0,
    sourceBytesAvoided: 0,
    unbudgetedReads: 0,
  }
}

class ContextCache {
  constructor(root) {
    this.root = root
    this.memory = new Map()
    this.chargedChains = new Map()
    this.stats = initialStats()
    this.invalidationSignature = null
  }

  async initialize() {
    await ensureManagedDirectory(this.root, 'cache')
    return this
  }

  async consumeInvalidations() {
    const eventPath = managedPath(this.root, 'invalidation.jsonl')
    const status = await fileStatusIfExists(eventPath)
    if (!status) return
    const signature = statSignature(status)
    if (signature === this.invalidationSignature) return
    const lines = (await readFile(eventPath, 'utf8')).split('\n').filter(Boolean)
    for (const line of lines) {
      const event = JSON.parse(line)
      if (event.schemaVersion !== INVALIDATION_SCHEMA) continue
      const path = safeRelativePath(event.path)
      if (this.memory.delete(path)) this.stats.invalidations += 1
      this.chargedChains.delete(path)
    }
    this.invalidationSignature = signature
  }

  async authoritativeRead(file, chainId) {
    if (chainId) {
      const result = await readFileWithinBudget({
        repositoryRoot: this.root,
        chainId,
        path: file.path,
      })
      this.stats.diskReads += 1
      return result.content
    }
    const content = await readFile(file.target, 'utf8')
    this.stats.unbudgetedReads += 1
    this.stats.diskReads += 1
    return content
  }

  async source(pathValue, options) {
    await this.consumeInvalidations()
    const file = await projectFile(this.root, pathValue)
    const signature = statSignature(file.status)
    const memory = this.memory.get(file.path)
    const charged = this.chargedChains.get(file.path)
    const sameContent = memory?.signature === signature
    if (sameContent && (!options.chainId || charged?.has(options.chainId))) {
      if (options.chainId) await checkCachedReadAccess({
        repositoryRoot: this.root, chainId: options.chainId, path: file.path,
      })
      this.stats.memoryHits += 1
      this.stats.sourceBytesAvoided += Buffer.byteLength(memory.content)
      return { ...memory, path: file.path, cache: 'memory', diskRead: false }
    }
    const content = await this.authoritativeRead(file, options.chainId)
    const hash = sha256(content)
    const entryPath = managedPath(this.root, 'cache', `${cacheKey(file.path)}.json`)
    const persisted = await readJsonIfExists(entryPath)
    const persistentHit = persisted?.schemaVersion === CACHE_SCHEMA
      && persisted.path === file.path && persisted.hash === hash
    if (persistentHit) this.stats.persistentHits += 1
    else this.stats.misses += 1
    const entry = {
      schemaVersion: CACHE_SCHEMA,
      path: file.path,
      hash,
      signature,
      content,
      verifiedAt: new Date().toISOString(),
    }
    await withFileLock(entryPath, async () => atomicJson(entryPath, entry))
    this.memory.set(file.path, entry)
    const verifiedChains = sameContent && charged ? charged : new Set()
    if (options.chainId) verifiedChains.add(options.chainId)
    this.chargedChains.set(file.path, verifiedChains)
    return { ...entry, cache: persistentHit ? 'persistent' : 'miss', diskRead: true }
  }

  async invalidate(pathValue) {
    const path = safeRelativePath(pathValue)
    const entryPath = managedPath(this.root, 'cache', `${cacheKey(path)}.json`)
    const memoryRemoved = this.memory.delete(path)
    this.chargedChains.delete(path)
    const persistentRemoved = await withFileLock(entryPath,
      async () => removeFileIfExists(entryPath))
    if (memoryRemoved || persistentRemoved) this.stats.invalidations += 1
    return { schemaVersion: CONTEXTBASE_SCHEMA, path, invalidated: memoryRemoved || persistentRemoved }
  }

  cacheStats() {
    const entries = [...this.memory.values()]
    const cacheBytes = entries.reduce((sum, entry) => sum + Buffer.byteLength(entry.content), 0)
    const requests = this.stats.memoryHits + this.stats.persistentHits + this.stats.misses
    return {
      schemaVersion: CONTEXTBASE_SCHEMA,
      ...this.stats,
      memoryEntries: entries.length,
      cacheBytes,
      requests,
      memoryHitRate: requests === 0 ? 0 : this.stats.memoryHits / requests,
      tokenEstimateAlgorithm: 'utf8-bytes-div-4-ceil',
      tokenEstimateAvoided: Math.ceil(this.stats.sourceBytesAvoided / 4),
    }
  }

  async budgetReport(chainId) {
    const budget = await readBudgetStatus({ repositoryRoot: this.root, chainId })
    return { schemaVersion: CONTEXTBASE_SCHEMA, chainId, budget, cache: this.cacheStats() }
  }
}

export {
  CACHE_SCHEMA,
  ContextCache,
  INVALIDATION_SCHEMA,
}
