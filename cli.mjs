#!/usr/bin/env node
import { stdin } from 'node:process'
import { createInterface } from 'node:readline'
import { installContextBase } from './installer.mjs'
import { createContextBaseService } from './contextbase-runner.mjs'

const MAX_STDIN_BYTES = 1_048_576

async function readInput() {
  const chunks = []
  let bytes = 0
  for await (const chunk of stdin) {
    bytes += chunk.length
    if (bytes > MAX_STDIN_BYTES) throw new Error('ContextBase stdin exceeds 1 MiB')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  return text ? JSON.parse(text) : {}
}

async function runBroker(repositoryRoot) {
  const service = await createContextBaseService(repositoryRoot)
  const lines = createInterface({ input: stdin, crlfDelay: Infinity })
  for await (const line of lines) {
    if (!line.trim()) continue
    let requestId = null
    try {
      const request = JSON.parse(line)
      requestId = typeof request.requestId === 'string' ? request.requestId : null
      if (!requestId) throw new Error('requestId is required')
      const output = await service.execute(request.operation, request.input)
      process.stdout.write(`${JSON.stringify({ requestId, status: 'succeeded', output })}\n`)
    } catch (error) {
      process.stdout.write(`${JSON.stringify({ requestId, status: 'failed', error: {
        code: error instanceof Error && typeof error.code === 'string'
          ? error.code : 'CONTEXTBASE_EXECUTION_FAILED',
        message: error instanceof Error ? error.message : String(error),
      } })}\n`)
    }
  }
}

async function main() {
  const command = process.argv[2]
  const repositoryRoot = process.argv[3]
  if (!command) throw new Error('operation is required')
  if (!repositoryRoot) throw new Error('repositoryRoot is required')
  if (command === 'install') {
    console.log(JSON.stringify(await installContextBase(repositoryRoot)))
    return
  }
  if (command === 'broker') {
    await runBroker(repositoryRoot)
    return
  }
  const service = await createContextBaseService(repositoryRoot)
  console.log(JSON.stringify(await service.execute(command, await readInput())))
}

try {
  await main()
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
}
