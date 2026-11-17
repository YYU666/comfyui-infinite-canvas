# Fixed worker isolation API

`pcg_isolation.preflight()` returns `{available, kind, code, message}`. The only
supported kind is `windows-appcontainer`. Availability requires creating and
cleaning a unique per-user AppContainer, staging the standard-library interpreter,
and actually starting it with the native security attributes and resource job.
Unsupported platforms and failures return `ISOLATION_UNAVAILABLE`. There is no
ordinary-process fallback. Availability is cached for this host process; every
execution still creates its own container, validates startup and fails closed.

`execute(request: bytes, *, cancelled=None, timeout=15,
memory_bytes=268435456, max_output_bytes=16777216) -> bytes` executes only the
fixed repository worker. The cancellation callback is host-owned and takes no
arguments. Errors are `IsolationError` with `code` and `message`:
`ISOLATION_UNAVAILABLE`, `CANCELLED`, `TIMEOUT`, `BUDGET_EXCEEDED`, `WORKER_FAILED`.
Input is at most 32 MiB; output at most 64 MiB; wall time at most 120 seconds;
memory is 64 MiB–1 GiB. Defaults are 15 seconds, 256 MiB and 16 MiB output.
Native user-mode CPU time is bounded to half the wall budget (minimum 0.1s).
The native quota exit maps to `BUDGET_EXCEEDED`. A worker may handle an allocation
failure itself; the host must continue validating its protocol response.

The runtime imports this wrapper and passes approved bounded JSON bytes. It does
not supply a source file, executable, expression, command, project path or asset
path. Staging is a closed list: worker, contracts, graph, geometry, fields, export
and registry. The interpreter comes from the host interpreter's own directory,
which must contain the standard-library zip and matching windowless executable.
Only explicit standard-library extension DLLs are copied; no site-packages,
user-site or environment Python paths are loaded (`-I -S -B`, restricted `_pth`).

## Native boundary

Each process uses a unique capability-free Windows AppContainer SID; the staged
runtime/code grants that SID read/execute only. Staging has a protected DACL
(host owner, SYSTEM and this unique SID), excluding inherited broad package
permissions. One owned temporary subtree grants
write access and low integrity. The inherited Windows/system access permitted to
AppContainers remains part of the OS boundary; this is not a claim that every
system file is unreadable. No user/project folder grants are added. The unique
profile's own OS-managed application data is permitted and removed on cleanup.
Profile environment paths point inside the owned temp subtree. Environment
contains only system directory/drive, a system-only PATH and owned profile/temp
locations. Windows rewrites TEMP to the container-specific owned subtree.

Extended startup attributes explicitly allow only stdin/stdout/stderr handles,
set zero capability grants, and prohibit child processes. A suspended child is
assigned to a JobObject before its first instruction runs. The job enforces one
active process, per-process/job committed-memory limits, user CPU time and
kill-on-close. Timeout, cancellation, output overflow and cleanup terminate only
that owned job. Resource jobs and interpreter flags supplement AppContainer;
neither is presented as an OS file/network sandbox by itself.

The windowless executable is necessary here: the console executable exits during
DLL initialization in this container. Explicit inherited stdio pipes still carry
the single JSON request/response. A startup path-resolution warning may appear on
bounded stderr; stderr is never mixed with protocol output or exposed verbatim.

## Reproducible local evidence

Run `test_pcg_isolation.py` using the bundled host interpreter, with this checkout
on `sys.path`. Six tests pass locally on 2026-11-17. Tests capability-skip on an
unsupported host; a skip is not acceptance evidence. Local proof actually checked:

- Process token `TokenIsAppContainer=1`, `TokenCapabilities.count=0`.
- Read/append/create on a separate owned synthetic private fixture: EACCES.
- Write to staged trusted code: EACCES; own temp write succeeds.
- Socket connect to documentation-only address: WinError 10013 (WSAEACCES).
- Child-process creation: WinError 367 (blocked by creation policy).
- Synthetic parent environment sentinel absent; only nine allowlisted keys.
- A 512 MiB allocation raises MemoryError under a 128 MiB job limit.
- Native CPU quota kills a busy fixture with `0xC0000044` before wall timeout.
- Wall timeout, output overflow and cancellation terminate the owned job;
  a subsequent independent job succeeds.

No live service, real user file, network service, credential, installation,
administrator privilege, virtual machine or third-party sandbox is involved.
Private synthetic worker sources exist only in the test file. The production
preflight uses a fixed startup assertion and exposes no code-execution API.
