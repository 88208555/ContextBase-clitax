---
name: contextbase
description: "Provide verified symbol-level TS/JS code, exact references, bounded dependency context, shared cache, and project maps when an agent needs repository code context. Use whole-file fallback only for unsupported languages and count it against an active Aimlock read budget."
---

# ContextBase

Use ContextBase for repository code supply. It reduces repeated full-file context; it does not authorize mutation and does not replace Aimlock, ArchGuard, Swarm, or Validator.

## Required flow

1. Call local `capabilities` and use its JSON Schemas.
2. Run one long-lived `cli-contextbase broker <repositoryRoot>` per project when multiple clients or agents share context.
3. When an Aimlock chain is active, include its `chainId` in `symbol-read`, `refs-read`, `map-build`, and `context-pack`. Never bypass an exhausted read budget.
4. Use `symbol-read` with an explicit dependency depth from 0 through 2. It returns the definition and only resolved called-symbol definitions.
5. Use `refs-read` for TypeScript/JavaScript references. Each result carries three surrounding lines.
6. Build a code map only when at least 30 TS/JS source files exist. A smaller project is skipped before source content is read.
7. Treat `map-get.stale=true` as a blocking refresh requirement. Do not use a stale map as current truth.
8. Unsupported languages return `whole-file-fallback` with `lsp-adapter-not-installed`; never describe that response as symbol-level supply.

## Operations

`capabilities`, `help`, `map-build`, `map-get`, `symbol-read`, `refs-read`, `cache-stats`, `budget-report`, `invalidate`, `context-pack`.

All one-shot commands use `cli-contextbase <operation> <repositoryRoot>` and read JSON from stdin. Broker requests are newline-delimited JSON objects containing `requestId`, `operation`, and `input`.

## Trust boundary

- Cached content receives a SHA-256 when read. A stable in-process entry is reused only while device, inode, size, mtime, and ctime match; any change forces a new read and hash.
- A persisted cache from an earlier process is never trusted from metadata alone: the source is re-read and its hash compared before reuse.
- Cross-client zero-read hits require all clients to use the same long-lived broker. Separate one-shot processes cannot share memory and must reverify disk content.
- TypeScript/JavaScript uses the installed TypeScript language service. Other language adapters are not installed in this version.
- Cache and map files live under `.contextbase/`; they are derived data, never source authority.

## Integration

- Aimlock supplies the read budget and can resolve exact target symbols from a fresh ContextBase map.
- ArchGuard checkpoint emits cache invalidation records; the broker invalidates matching memory entries before the next supply.
- `context-pack` is the Swarm work packet: requested symbols plus depth-bounded dependencies and cache evidence.
- Validator may use `refs-read` output for dependency validation; it must still run its own delivery gates.
