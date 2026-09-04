import { copyFile, lstat, mkdir, realpath } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

async function ensureDirectory(path) {
  try {
    await mkdir(path, { mode: 0o700 })
  } catch (error) {
    if (!(error instanceof Error && error.code === 'EEXIST')) throw error
  }
  const status = await lstat(path)
  if (status.isSymbolicLink() || !status.isDirectory()) {
    throw new Error(`${path} must be a real directory`)
  }
}

async function installContextBase(targetRootValue) {
  const targetRoot = await realpath(resolve(targetRootValue))
  const packageRoot = dirname(fileURLToPath(import.meta.url))
  let destination = targetRoot
  for (const segment of ['.codex', 'skills', 'contextbase']) {
    destination = resolve(destination, segment)
    await ensureDirectory(destination)
  }
  for (const name of ['SKILL.md', 'skill.json']) {
    await copyFile(resolve(packageRoot, 'skill', name), resolve(destination, name))
  }
  return { installed: true, destination, files: ['SKILL.md', 'skill.json'] }
}

export { installContextBase }
