import { lstat } from 'node:fs/promises'
import {
  CONTEXTBASE_SCHEMA,
  atomicJson,
  ensureManagedDirectory,
  managedPath,
  projectFile,
  projectSourceFiles,
  readJsonIfExists,
  sha256,
  statSignature,
  withFileLock,
} from './contextbase-fs.mjs'
import { sourceAnalysis } from './contextbase-typescript.mjs'

const MAP_SCHEMA = 'contextbase.project-map/1.0'
const MAP_THRESHOLD = 30

function fileSummary(analysis) {
  const exported = analysis.declarations.filter((item) => item.exported).map((item) => item.name)
  if (exported.length) return `Exports ${exported.join(', ')}`
  return 'No exported symbols'
}

function mapEntry(source) {
  const analysis = sourceAnalysis(source.path, source.content)
  const exported = analysis.declarations.filter((item) => item.exported).map((item) => ({
    name: item.name,
    kind: item.kind,
    startLine: item.startLine,
    endLine: item.endLine,
  }))
  return {
    path: source.path,
    hash: source.hash,
    signature: source.signature,
    summary: fileSummary(analysis),
    exports: exported,
    imports: [...new Set(analysis.imports.map((item) => item.module))].sort(),
  }
}

function mapDigest(entries) {
  return sha256(JSON.stringify(entries.map((entry) => ({
    path: entry.path,
    hash: entry.hash,
    exports: entry.exports,
    imports: entry.imports,
  }))))
}

async function buildProjectMap(root, cache, input) {
  const files = await projectSourceFiles(root)
  if (files.length < MAP_THRESHOLD) {
    return {
      schemaVersion: CONTEXTBASE_SCHEMA,
      skipped: true,
      reason: 'project-below-map-threshold',
      threshold: MAP_THRESHOLD,
      sourceFileCount: files.length,
      readFiles: 0,
    }
  }
  const entries = []
  for (const path of files) {
    const source = await cache.source(path, { chainId: input.chainId })
    entries.push(mapEntry(source))
  }
  const map = {
    schemaVersion: MAP_SCHEMA,
    mapId: mapDigest(entries),
    builtAt: new Date().toISOString(),
    sourceFileCount: entries.length,
    tree: entries.map((entry) => entry.path),
    entries,
  }
  const directory = await ensureManagedDirectory(root)
  const path = managedPath(root, 'project-map.json')
  await withFileLock(path, async () => atomicJson(path, map))
  return { schemaVersion: CONTEXTBASE_SCHEMA, skipped: false, path,
    directory, map, readFiles: entries.length }
}

async function currentSignature(root, path) {
  try {
    return statSignature((await projectFile(root, path)).status)
  } catch (error) {
    if (error instanceof Error && error.code === 'ENOENT') return null
    throw error
  }
}

async function getProjectMap(root) {
  const path = managedPath(root, 'project-map.json')
  const map = await readJsonIfExists(path)
  if (!map) {
    return { schemaVersion: CONTEXTBASE_SCHEMA, available: false, reason: 'map-not-built' }
  }
  if (map.schemaVersion !== MAP_SCHEMA || !Array.isArray(map.entries)) {
    throw new Error('ContextBase project map is invalid')
  }
  const stalePaths = []
  for (const entry of map.entries) {
    const signature = await currentSignature(root, entry.path)
    if (signature !== entry.signature) stalePaths.push(entry.path)
  }
  return {
    schemaVersion: CONTEXTBASE_SCHEMA,
    available: true,
    stale: stalePaths.length > 0,
    stalePaths,
    map,
  }
}

async function mapStorageBytes(root) {
  const path = managedPath(root, 'project-map.json')
  try {
    return (await lstat(path)).size
  } catch (error) {
    if (error instanceof Error && error.code === 'ENOENT') return 0
    throw error
  }
}

export {
  MAP_SCHEMA,
  MAP_THRESHOLD,
  buildProjectMap,
  getProjectMap,
  mapStorageBytes,
}
