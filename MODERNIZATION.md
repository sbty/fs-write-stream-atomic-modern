# Modernization record

## Changed

- Renamed package metadata to `fs-write-stream-atomic-modern` while preserving
  the original author and ISC license.
- Declared Node.js 22 or newer.
- Replaced `iferr` with direct callback branches.
- Replaced `graceful-fs` with `node:fs`.
- Replaced the legacy tap/standard/rimraf test stack with `node:test`,
  `node:assert/strict`, and current filesystem cleanup APIs.
- Added upstream Golden Master and differential tests, deterministic Windows
  EPERM tests, concurrency and large-write coverage, type tests, and tarball
  smoke tests.
- Added `index.d.ts` for the callable and constructible CommonJS export.
- Added GitHub Actions coverage for Linux Node 22/24/26 and Node 24 on Windows
  and macOS.

## Deliberately unchanged

- CommonJS export and `main: index.js`
- Function-constructor invocation with and without `new`
- `util.inherits`
- Temporary-name algorithm and `imurmurhash`
- `readable-stream` Writable implementation
- Finish suppression, delayed close, atomic rename sequence, and error ordering
- Windows `EPERM` same-content recovery
- Observable double-underscore properties
- Lack of an `EXDEV` copy fallback

No Promise-only API, ESM-only entry point, class hierarchy, build directory, or
restrictive `exports` map was introduced.

## Dependency decisions

Runtime dependencies before: 4.

- `graceful-fs`
- `iferr`
- `imurmurhash`
- `readable-stream`

Runtime dependencies after: 2.

- `imurmurhash`
- `readable-stream`

`iferr` was unnecessary for two straightforward callback branches.
`graceful-fs` was replaced with the platform implementation; the loss of its
descriptor-exhaustion queue is disclosed in `COMPATIBILITY.md`.

`node:stream.Writable` was tested as a direct replacement. Its automatic
destroy/close defaults initially emitted `close` before rename and emitted it
twice. Disabling those defaults restored ordinary success behavior, but
write-after-end then left the temporary stream unfinished, differing from
upstream error and cleanup behavior. Rather than grow a fragile compatibility
shim around core stream internals, the fork retains `readable-stream`.

`imurmurhash` remains because `__atomicTmp` exposes its output. Random UUIDs or
a different hash would be an intentional compatibility break; embedding a
custom MurmurHash implementation would add more code and maintenance risk than
the small dependency removes.

## Security and data-loss decisions

The project does not silently change predictable temporary names or default
open flags because both are observable. The associated local-directory threat
model is documented in `ANALYSIS.md`. The write/close/chown/rename order and
cleanup paths remain the primary data-loss protections.

The package still does not call `fsync`, guarantee power-loss durability, or
copy across filesystems. Claims in the README are limited accordingly.

## Node and CI support

The supported range is `>=22`. CI tests Node 22, 24, and 26 on Ubuntu, plus
Node 24 on Windows and macOS. Node 26 is an available current release and is
supported by `actions/setup-node`.

Every CI job runs `npm ci`, the full tests and type check, `npm pack --dry-run`,
and the real tarball installation smoke test.
