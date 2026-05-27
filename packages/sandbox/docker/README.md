# Sandbox base image

The image built from this directory is the kernel-side half of the platform's
isolation contract. The host-side half lives in `../src/executor.ts`. Both
must agree, or the contract is broken.

Build:

```
docker build -t temper-sandbox-base:latest .
```

## Why each hardening flag exists

The `SandboxExecutor` passes every one of these to `docker create`. Removing
any of them is a security regression — call it out in review.

| Flag | What it does | What we lose if we drop it |
|---|---|---|
| `--network=temper-net` (NOT default bridge / NOT host) | The sandbox shares a user-defined network with the egress proxy only. No mock-system, no Postgres, no Temporal, no host. | Sandbox could resolve and talk to anything on the host network — bypassing the egress proxy entirely. |
| `HTTP_PROXY` / `HTTPS_PROXY` env | Points axios + the baked Node fetch at the egress proxy. Combined with the network restriction above, this is the only way out. | Outbound calls bypass the allowlist; we lose the egress audit log. |
| `EGRESS_ALLOWLIST` env | Lets the proxy know which hosts this run is allowed to reach. The proxy is the enforcement point. | Proxy can't distinguish per-run policy. |
| `--read-only` (rootfs) | The container's root filesystem is mounted read-only. Writing to `/etc/passwd` or dropping a payload at `/usr/local/bin/...` fails with EROFS. | Payload could persist a backdoor inside the image at runtime (harmless after exit, but enables in-run privesc chains). |
| `--tmpfs /tmp size=10m` | Gives the payload a small ephemeral scratch dir. Wiped on container exit. | Either the payload can't write temp files at all (breaking legit use), or it gets to write to the read-only rootfs. |
| `--cap-drop=ALL` | Drops every Linux capability. No `CAP_NET_RAW`, `CAP_SYS_ADMIN`, nothing. | Payload could open raw sockets, ptrace siblings, mount filesystems, etc. |
| `--security-opt=no-new-privileges` | Even if the payload finds a setuid binary, it can't gain privileges. | One bad binary in the image undoes the non-root user. |
| `--security-opt=seccomp=seccomp.json` | Custom seccomp profile. Default-deny with a Node-friendly allowlist; explicit denies for `ptrace`, `mount`, `kexec_load`, `init_module`, `bpf`, `unshare`, `setns`, etc. | Payload could load a kernel module, chroot out, peek at sibling containers, or attempt CVE chains against the host kernel. |
| `User: 10001:10001` (non-root) | Process runs as a dedicated unprivileged uid. Even if seccomp slips, no filesystem write authority. | Payload runs as root inside the container — far easier to chain into a real CVE. |
| `--memory=256m`, `--memory-swap=256m` | cgroup-enforced memory cap, no swap. OOM-killed by the kernel if exceeded. | Payload can exhaust host RAM (DoS). |
| `--cpus=0.5` (NanoCpus) | cgroup CPU share. Payload can't starve other tenants. | One bad while(true) takes the host down. |
| `--pids-limit=64` | Process count cap. Fork bombs hit this wall. | Payload spawns thousands of subprocesses. |
| `Ulimits: nproc=64` | Belt-and-suspenders for the pids limit. | Same as above. |
| `AutoRemove: true` | Container is gone the moment it exits. No forensic remnants on the host. | Stale containers accumulate; one bad one can be re-attached. |
| `RestartPolicy: no` | A sandbox run is one-shot. Never restart. | A loop in the entrypoint could spin forever via Docker's restart logic. |
| Walltime SIGKILL (host-side) | Host sends SIGKILL after `req.timeout_ms`. We do not trust the payload's own `setTimeout`. | Payload could shadow `setTimeout` and never exit. |

## Image content choices

- **`node:20-slim`, not `:alpine`.** Alpine's musl periodically breaks SFTP/SSH
  modules and certificate handling. glibc keeps the integration surface boring.
- **Only `ca-certificates` installed.** No `curl`, `wget`, `bash`, no compilers.
  Anything beyond the JS runtime is attack surface.
- **All deps installed `--omit=dev` at build time.** `npm` is never invoked at
  runtime, so a payload can't drop an npm postinstall script.
- **`NODE_OPTIONS=--max-old-space-size=200`.** V8 heap capped just below the
  256MB cgroup limit so we get a readable JS OOM in stderr instead of an opaque
  SIGKILL when the payload mallocs forever.
- **Non-root uid 10001 with `/usr/sbin/nologin`.** Fixed uid so host bind-mount
  permissions are predictable; nologin shell so an escaped payload can't
  upgrade to an interactive session.

## What this image deliberately does NOT do

- It does **not** policy-wrap the payload at the JS layer (no `vm2`, no
  `--experimental-permissions`). The isolation contract is enforced by the
  kernel via seccomp + cgroups + read-only fs + dropped caps + non-root user.
  JS-layer wrappers are defense-in-depth at best and a footgun (false sense
  of security) at worst.
- It does **not** trust the payload to police its own walltime. SIGKILL comes
  from the host.
- It does **not** trust the payload's self-reported egress. The egress proxy
  is the source of truth; the host fetches the log by correlation id after
  the run.
