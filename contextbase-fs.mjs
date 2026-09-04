import { createHash, randomUUID } from 'node:crypto'
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, relative, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const CONTEXTBASE_SCHEMA = 'contextbase.local/1.0'
const MANAGED_ROOT = '.contextbase'
const MAX_PROJECT_FILES = 10_000
const LOCK_TIMEOUT_MS = 2_000
const LOCK_POLL_MS = 10
const SOURCE_EXTENSIONS = new Set(['.cjs', '.js', '.jsx', '.mjs', '.ts', '.tsx'])
const IGNORED_DIRECTORIES = new Set([
  '.aimlock', '.contextbase', '.git', '.runtime', 'coverage', 'dist', 'node_modules',
])

function fail(code, message) {
  const error = new Error(message)
  error.code = code
  throw error
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function safeIdentifier(value, field) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    fail('CONTEXTBASE_IDENTIFIER_INVALID', `${field} must be a safe identifier`)
  }
  return value
}

function safeRelativePath(value, field = 'path') {
  if (typeof value !== 'string' || !value || value !== value.normalize('NFC')
    || isAbsolute(value) || /^[A-Za-z]:/.test(value) || value.includes('\\')
    || /[\u0000-\u001f\u007f]/.test(value)) {
    fail('CONTEXTBASE_PATH_UNSAFE', `${field} is unsafe`)
  }
  const parts = value.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    fail('CONTEXTBASE_PATH_UNSAFE', `${field} is unsafe`)
  }
  return parts.join('/')
}

function assertInside(root, target, field) {
  const path = relative(root, target)
  if (path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith('../'))) return
  fail('CONTEXTBASE_PATH_ESCAPE', `${field} escapes the repository`)
}

async function repositoryRoot(value) {
  const explicit = resolve(value)
  const status = await lstat(explicit)
  if (status.isSymbolicLink() || !status.isDirectory()) {
    fail('CONTEXTBASE_ROOT_INVALID', 'repositoryRoot must be a real directory')
  }
  return realpath(explicit)
}

async function projectFile(root, value) {
  const path = safeRelativePath(value)
  const target = resolve(root, ...path.split('/'))
  assertInside(root, target, 'project path')
  const status = await lstat(target)
  if (status.isSymbolicLink() || !status.isFile()) {
    fail('CONTEXTBASE_FILE_INVALID', `${path} must be a regular file`)
  }
  const canonical = await realpath(target)
  assertInside(root, canonical, 'project file')
  return { path, target: canonical, status }
}

async function ensureManagedDirectory(root, ...parts) {
  let current = root
  for (const [index, part] of [MANAGED_ROOT, ...parts].entries()) {
    if (index > 0) safeIdentifier(part, 'managed path segment')
    current = resolve(current, part)
    assertInside(root, current, 'managed directory')
    try {
      await mkdir(current, { mode: 0o700 })
    } catch (error) {
      if (!(error instanceof Error && error.code === 'EEXIST')) throw error
    }
    const status = await lstat(current)
    if (status.isSymbolicLink() || !status.isDirectory()) {
      fail('CONTEXTBASE_MANAGED_PATH_INVALID', 'managed directories must be real directories')
    }
  }
  return current
}

function managedPath(root, ...parts) {
  return resolve(root, MANAGED_ROOT, ...parts)
}

async function atomicJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { flag: 'wx', mode: 0o600 })
  await rename(temporary, path)
}

async function readJsonIfExists(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error instanceof Error && error.code === 'ENOENT') return null
    throw error
  }
}

async function removeFileIfExists(path) {
  try {
    await unlink(path)
    return true
  } catch (error) {
    if (error instanceof Error && error.code === 'ENOENT') return false
    throw error
  }
}

async function withFileLock(path, operation) {
  const lockPath = `${path}.lock`
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  let handle
  while (!handle) {
    try {
      handle = await open(lockPath, 'wx', 0o600)
    } catch (error) {
      if (!(error instanceof Error && error.code === 'EEXIST')) throw error
      if (Date.now() >= deadline) fail('CONTEXTBASE_LOCK_TIMEOUT', 'managed state is busy')
      await delay(LOCK_POLL_MS)
    }
  }
  try {
    return await operation()
  } finally {
    await handle.close()
    await unlink(lockPath)
  }
}

async function walkDirectory(root, directory, files) {
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isSymbolicLink() || IGNORED_DIRECTORIES.has(entry.name)) continue
    const target = resolve(directory, entry.name)
    if (entry.isDirectory()) await walkDirectory(root, target, files)
    else if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))) {
      files.push(relative(root, target).split('\\').join('/'))
    }
    if (files.length > MAX_PROJECT_FILES) {
      fail('CONTEXTBASE_PROJECT_LIMIT', `project exceeds ${MAX_PROJECT_FILES} source files`)
    }
  }
}

async function projectSourceFiles(root) {
  const files = []
  await walkDirectory(root, root, files)
  return files.sort()
}

function statSignature(status) {
  return [status.dev, status.ino, status.size, status.mtimeMs, status.ctimeMs].join(':')
}

function cacheKey(path) {
  return sha256(`contextbase-cache:${path}`)
}

export {
  CONTEXTBASE_SCHEMA,
  MANAGED_ROOT,
  SOURCE_EXTENSIONS,
  atomicJson,
  cacheKey,
  ensureManagedDirectory,
  fail,
  managedPath,
  projectFile,
  projectSourceFiles,
  readJsonIfExists,
  removeFileIfExists,
  repositoryRoot,
  safeIdentifier,
  safeRelativePath,
  sha256,
  statSignature,
  withFileLock,
}
