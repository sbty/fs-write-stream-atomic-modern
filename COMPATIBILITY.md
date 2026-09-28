# Compatibility

## Reference upstream

The reference implementation is `fs-write-stream-atomic@1.0.10`. The modern
test suite installs that exact version as a development-only dependency and
runs the same scenarios against isolated upstream and modern directories.

## Public API

The package remains CommonJS and exports one function constructor:

```js
const atomic = require('fs-write-stream-atomic-modern')
const called = atomic(path, options)
const constructed = new atomic(path, options)
```

Both forms return a `readable-stream` Writable. The implementation deliberately
retains `util.inherits` and the upstream function-constructor behavior.

## Writable semantics

`write`, `end`, piping, backpressure, `drain`, `destroy`, EventEmitter methods,
mixed string/Buffer input, and encoding behavior are covered by modern and
differential tests. `write()` after `end()` and `destroy(error)` are explicitly
compared with upstream because current `node:stream` differs on those paths.

Options continue to reach the underlying filesystem WriteStream. Documented
options are `chown`, `encoding`, `mode`, and `flags`. `isWin` remains accepted
as an observable compatibility option. Other stream options are not newly
guaranteed, but are not filtered out.

## Event ordering

Normal completion emits:

```text
open → finish → close
```

Piped completion also preserves upstream's observable order:

```text
pipe → finish → unpipe → close
```

Operation failures emit:

```text
error → close
```

`finish` and `close` are emitted at most once by the atomic completion path.

## Finish and close semantics

The outer Writable's ordinary finish is suppressed. It ends the temporary
WriteStream instead. Only after that stream closes, optional ownership succeeds,
and rename commits does the outer stream emit `finish`. The outer `close` is
then scheduled across an asynchronous boundary.

This means the destination exists with complete content at `finish`; neither
event is emitted merely because the outer Writable accepted `end()`.

## Atomic rename semantics

Each invocation writes to a distinct sibling temporary path and then calls
`rename(temp, target)`. There is no `EXDEV` copy fallback. Atomic replacement
therefore requires the filesystem's same-filesystem rename guarantees. No
`fsync` durability guarantee is made.

Concurrent writers may finish in any order. The supported invariant is that a
successful final destination contains one writer's complete payload, not mixed
or partial chunks. Windows can report a replacement race as `EPERM`; such an
error remains observable unless the established same-content recovery applies.

## Temporary file semantics

The name remains:

```text
target + "." + decimal MurmurHash3(module filename, pid, invocation counter)
```

`__atomicTarget` and `__atomicTmp` remain observable. The double-underscore
properties are compatibility-tested but are not promoted to documented public
TypeScript API.

## chown

When `options.chown` is present, the temporary file is closed first, then
`chown(temp, uid, gid)` runs, and only then does rename occur. A chown failure
causes temporary-file cleanup followed by `error` and `close` without `finish`.
Actual chown availability and permissions are platform-dependent.

## Windows EPERM behavior

For an error with all three conditions—`isWin`, `syscall === 'rename'`, and
`code === 'EPERM'`—the temporary file and destination are hashed with SHA-512.
Equal hashes are treated as successful replacement after temporary cleanup.
Different hashes or either read failing preserve the original rename error.

## Cleanup and errors

Temporary files are removed after successful rename by virtue of the rename,
and cleanup is attempted after write, chown, rename, or EPERM-validation errors.
As upstream did, a cleanup unlink failure does not replace the operation error.
This can leave a temporary file, which is a known disk-usage risk.

An `error` event without a listener retains normal EventEmitter behavior and can
terminate the process. Errors are not swallowed.

## Symlinks and platform differences

Rename replaces the target directory entry, so a symlink target is replaced
rather than streaming into its referent on platforms that support this rename.
Symlink creation itself may require additional Windows privileges.

Overlong-path error codes differ by OS (`ENAMETOOLONG` and `ENOENT` have both
been observed). Filesystem rename guarantees, chown, permission bits, and
network filesystem behavior also remain platform-specific.

## Intentional differences

- `graceful-fs` was replaced by `node:fs`. The graceful-fs process-wide
  `EMFILE`/`ENFILE` retry queue is therefore not retained.
- `iferr` was replaced by direct callbacks with the same error routing.
- The supported runtime is Node.js 22 and newer.
- Test tooling, package metadata, documentation, and TypeScript declarations
  are modernized.

`readable-stream` and `imurmurhash` remain runtime dependencies because
removing either produced or risked observable compatibility differences.

## Known quirks

- Temporary names are predictable to another local process that knows the PID
  and invocation sequence. Changing this would alter observable names.
- Caller-supplied flags can change semantics. In particular, flags apply to the
  temporary file, not directly to an existing destination.
- No automatic retry is added for descriptor exhaustion or general rename
  failures.
- Cleanup failure can leave a temporary artifact.
