// Mock SFTP server backed by an in-memory virtual filesystem.
//
// Exposes:
//   /orders/<YYYY-MM-DD>.csv  for the last 7 days (today + 6 prior days)
//
// Each CSV has header `id,customer,amount,currency,created_at` followed by 10
// fake orders for that calendar day. Authentication is password-only:
// username=demo, password=demo. The host key is generated fresh on every
// startup (this is a demo / non-production system).
//
// Port: MOCK_SFTP_PORT env var, default 5022. In docker-compose this listens
// on 22 inside the container and is mapped to 5022 on the host.
//
// Implementation notes:
//   - ssh2's SFTP protocol is low-level. We model file handles as small Buffers
//     and store per-handle state (path, read offset, dir cursor) in a map.
//   - We only implement what a typical SFTP client needs to list a directory
//     and read a file: REALPATH, STAT, LSTAT, FSTAT, OPENDIR, READDIR, CLOSE,
//     OPEN, READ. Writes / removes return OP_UNSUPPORTED — this is a
//     read-only feed.

import { randomBytes } from "node:crypto";
// ssh2 is a CommonJS module; some bundlers/loaders can't statically detect its
// named exports under ESM. Use the default import and pull values off it at
// runtime, while still grabbing the types from the named export form.
import ssh2 from "ssh2";
import type { Server as SSH2Server, SFTPWrapper } from "ssh2";

const { Server, utils } = ssh2;

// SFTP status / mode constants. ssh2 exposes these under utils.sftp; we pull
// them out once so call sites stay readable.
const STATUS = utils.sftp.STATUS_CODE;
const OPEN_MODE = utils.sftp.OPEN_MODE;

// ============================================================
// Virtual filesystem
// ============================================================

type VFile = { type: "file"; content: Buffer; mtime: number };
type VDir = { type: "dir"; children: Map<string, VFile | VDir>; mtime: number };
type VNode = VFile | VDir;

const CUSTOMERS = [
  "Acme Corp",
  "Globex",
  "Initech",
  "Umbrella",
  "Stark Industries",
  "Wayne Enterprises",
  "Soylent",
  "Cyberdyne",
  "Tyrell Corp",
  "Hooli",
];

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

function ymd(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function generateCsvForDay(dateStr: string): Buffer {
  const lines: string[] = ["id,customer,amount,currency,created_at"];
  // Deterministic-ish but not strictly seeded; fine for a demo.
  for (let i = 0; i < 10; i++) {
    const customer = CUSTOMERS[Math.floor(Math.random() * CUSTOMERS.length)]!;
    const amount = (Math.random() * 500 + 5).toFixed(2);
    // Random time within that day in UTC.
    const hours = Math.floor(Math.random() * 24);
    const minutes = Math.floor(Math.random() * 60);
    const seconds = Math.floor(Math.random() * 60);
    const iso = `${dateStr}T${pad(hours)}:${pad(minutes)}:${pad(seconds)}Z`;
    const id = `ord_${dateStr.replace(/-/g, "")}_${i.toString().padStart(3, "0")}`;
    lines.push(`${id},${customer},${amount},USD,${iso}`);
  }
  return Buffer.from(lines.join("\n") + "\n", "utf8");
}

function buildVfs(): VDir {
  const now = Date.now();
  const ordersDir: VDir = { type: "dir", children: new Map(), mtime: now };
  const root: VDir = {
    type: "dir",
    children: new Map([["orders", ordersDir]]),
    mtime: now,
  };
  // Generate the last 7 days (today + 6 prior days), UTC.
  const today = new Date();
  for (let i = 0; i < 7; i++) {
    const d = new Date(today.getTime() - i * 24 * 60 * 60 * 1000);
    const name = `${ymd(d)}.csv`;
    ordersDir.children.set(name, {
      type: "file",
      content: generateCsvForDay(ymd(d)),
      mtime: d.getTime(),
    });
  }
  return root;
}

let VFS: VDir = buildVfs();

/**
 * Normalize an incoming SFTP path. We treat paths as POSIX-style absolute,
 * with "." / "" meaning root. Returns the normalized absolute path and the
 * node (or null if missing).
 */
function resolvePath(p: string): { abs: string; node: VNode | null } {
  let normalized = p;
  if (!normalized || normalized === ".") normalized = "/";
  if (!normalized.startsWith("/")) normalized = "/" + normalized;
  // Collapse `//` and trailing slashes (except root).
  normalized = normalized.replace(/\/+/g, "/");
  if (normalized.length > 1 && normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  if (normalized === "/") return { abs: "/", node: VFS };
  const segments = normalized.slice(1).split("/");
  let cur: VNode = VFS;
  for (const seg of segments) {
    if (cur.type !== "dir") return { abs: normalized, node: null };
    const next = cur.children.get(seg);
    if (!next) return { abs: normalized, node: null };
    cur = next;
  }
  return { abs: normalized, node: cur };
}

function attrsFor(node: VNode): {
  mode: number;
  uid: number;
  gid: number;
  size: number;
  atime: number;
  mtime: number;
} {
  const isDir = node.type === "dir";
  const mode = isDir ? 0o040755 : 0o100644;
  const size = isDir ? 0 : node.content.length;
  const mtime = Math.floor(node.mtime / 1000);
  return { mode, uid: 0, gid: 0, size, atime: mtime, mtime };
}

function longname(name: string, node: VNode): string {
  // Loosely mimic `ls -l` for clients that show it.
  const isDir = node.type === "dir";
  const perms = isDir ? "drwxr-xr-x" : "-rw-r--r--";
  const size = isDir ? 0 : node.content.length;
  const d = new Date(node.mtime);
  const month = d.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  const day = pad(d.getUTCDate());
  const hm = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  return `${perms} 1 demo demo ${size.toString().padStart(8, " ")} ${month} ${day} ${hm} ${name}`;
}

// ============================================================
// SSH server
// ============================================================

const PORT = Number(process.env.MOCK_SFTP_PORT ?? 5022);
const HOST = "0.0.0.0";
const USERNAME = "demo";
const PASSWORD = "demo";

/**
 * Generate an ED25519 host key in OpenSSH format. ssh2's own keygen helper
 * produces the exact format its parser expects (Node's built-in PKCS#8 PEM
 * for ed25519 is rejected by ssh2's parseKey).
 */
function generateHostKey(): string {
  // utils.generateKeyPairSync returns { private, public } strings.
  const { private: privateKey } = (
    utils as unknown as {
      generateKeyPairSync: (
        type: "ed25519" | "rsa" | "ecdsa",
        opts?: { bits?: number },
      ) => { private: string; public: string };
    }
  ).generateKeyPairSync("ed25519");
  return privateKey;
}

export function buildServer(): SSH2Server {
  const hostKey = generateHostKey();
  const server = new Server(
    {
      hostKeys: [hostKey],
    },
    (client) => {
      // Auth: password only, demo/demo.
      client.on("authentication", (ctx) => {
        if (
          ctx.method === "password" &&
          ctx.username === USERNAME &&
          ctx.password === PASSWORD
        ) {
          ctx.accept();
        } else if (ctx.method === "none") {
          // Some clients probe with "none" first to discover allowed methods.
          ctx.reject(["password"], false);
        } else {
          ctx.reject();
        }
      });

      client.on("ready", () => {
        client.on("session", (acceptSession) => {
          const session = acceptSession();
          session.on("sftp", (acceptSftp) => {
            const sftp = acceptSftp() as SFTPWrapper;
            attachSftpHandlers(sftp);
          });
        });
      });

      client.on("error", () => {
        // Silently swallow per-client errors; in a real system we'd log.
      });
    },
  );

  return server;
}

type Handle =
  | { kind: "file"; path: string; node: VFile; offset: number }
  | { kind: "dir"; path: string; entries: Array<[string, VNode]>; cursor: number };

function attachSftpHandlers(sftp: SFTPWrapper): void {
  const handles = new Map<string, Handle>();
  let nextHandleId = 0;

  function newHandle(h: Handle): Buffer {
    const id = (nextHandleId++).toString();
    handles.set(id, h);
    return Buffer.from(id, "utf8");
  }

  function getHandle(buf: Buffer): Handle | undefined {
    return handles.get(buf.toString("utf8"));
  }

  function closeHandle(buf: Buffer): void {
    handles.delete(buf.toString("utf8"));
  }

  sftp.on("REALPATH", (reqid, path) => {
    const { abs } = resolvePath(path);
    sftp.name(reqid, [
      {
        filename: abs,
        longname: abs,
        attrs: attrsFor({ type: "dir", children: new Map(), mtime: Date.now() }),
      },
    ]);
  });

  sftp.on("STAT", (reqid, path) => {
    const { node } = resolvePath(path);
    if (!node) return sftp.status(reqid, STATUS.NO_SUCH_FILE);
    sftp.attrs(reqid, attrsFor(node));
  });

  sftp.on("LSTAT", (reqid, path) => {
    const { node } = resolvePath(path);
    if (!node) return sftp.status(reqid, STATUS.NO_SUCH_FILE);
    sftp.attrs(reqid, attrsFor(node));
  });

  sftp.on("FSTAT", (reqid, handleBuf) => {
    const h = getHandle(handleBuf);
    if (!h) return sftp.status(reqid, STATUS.FAILURE);
    if (h.kind === "file") return sftp.attrs(reqid, attrsFor(h.node));
    // dir
    const { node } = resolvePath(h.path);
    if (!node) return sftp.status(reqid, STATUS.NO_SUCH_FILE);
    sftp.attrs(reqid, attrsFor(node));
  });

  sftp.on("OPENDIR", (reqid, path) => {
    const { abs, node } = resolvePath(path);
    if (!node) return sftp.status(reqid, STATUS.NO_SUCH_FILE);
    if (node.type !== "dir") return sftp.status(reqid, STATUS.FAILURE);
    const entries: Array<[string, VNode]> = Array.from(node.children.entries());
    // Include `.` and `..` for client compatibility.
    entries.unshift([".", node], ["..", node]);
    const handle = newHandle({ kind: "dir", path: abs, entries, cursor: 0 });
    sftp.handle(reqid, handle);
  });

  sftp.on("READDIR", (reqid, handleBuf) => {
    const h = getHandle(handleBuf);
    if (!h || h.kind !== "dir") return sftp.status(reqid, STATUS.FAILURE);
    if (h.cursor >= h.entries.length) {
      return sftp.status(reqid, STATUS.EOF);
    }
    // Return the rest in one batch — directory is small.
    const batch = h.entries.slice(h.cursor).map(([name, node]) => ({
      filename: name,
      longname: longname(name, node),
      attrs: attrsFor(node),
    }));
    h.cursor = h.entries.length;
    sftp.name(reqid, batch);
  });

  sftp.on("OPEN", (reqid, filename, flags) => {
    // Read-only: reject any write/create/append/trunc flags.
    const writeFlags =
      OPEN_MODE.WRITE | OPEN_MODE.APPEND | OPEN_MODE.CREAT | OPEN_MODE.TRUNC | OPEN_MODE.EXCL;
    if ((flags & writeFlags) !== 0) {
      return sftp.status(reqid, STATUS.PERMISSION_DENIED);
    }
    const { abs, node } = resolvePath(filename);
    if (!node) return sftp.status(reqid, STATUS.NO_SUCH_FILE);
    if (node.type !== "file") return sftp.status(reqid, STATUS.FAILURE);
    const handle = newHandle({ kind: "file", path: abs, node, offset: 0 });
    sftp.handle(reqid, handle);
  });

  sftp.on("READ", (reqid, handleBuf, offset, length) => {
    const h = getHandle(handleBuf);
    if (!h || h.kind !== "file") return sftp.status(reqid, STATUS.FAILURE);
    const { content } = h.node;
    if (offset >= content.length) {
      return sftp.status(reqid, STATUS.EOF);
    }
    const end = Math.min(content.length, offset + length);
    const chunk = content.subarray(offset, end);
    sftp.data(reqid, chunk);
  });

  sftp.on("CLOSE", (reqid, handleBuf) => {
    closeHandle(handleBuf);
    sftp.status(reqid, STATUS.OK);
  });

  // Reject write-side ops cleanly so misbehaving clients get a real status
  // instead of a hang. Cast through `unknown` because ssh2's typed event map
  // declares each op with a different listener signature.
  const unsupported = (reqid: number): void => {
    sftp.status(reqid, STATUS.OP_UNSUPPORTED);
  };
  const unsupportedOps = [
    "WRITE",
    "REMOVE",
    "RENAME",
    "MKDIR",
    "RMDIR",
    "SETSTAT",
    "FSETSTAT",
    "SYMLINK",
  ];
  for (const op of unsupportedOps) {
    (sftp as unknown as { on: (event: string, listener: (reqid: number) => void) => void }).on(
      op,
      unsupported,
    );
  }
}

/** Reseed the virtual filesystem with fresh data. Useful for tests / demos. */
export function resetVfs(): void {
  VFS = buildVfs();
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  // Tiny entropy nudge — keeps Math.random output divergent across restarts.
  randomBytes(8);
  const server = buildServer();
  server.listen(PORT, HOST, () => {
    const addr = server.address();
    const actualPort = typeof addr === "object" && addr ? addr.port : PORT;
    // eslint-disable-next-line no-console
    console.log(
      `mock-sftp listening on ${HOST}:${actualPort} (demo/demo, files in /orders/)`,
    );
  });
}
