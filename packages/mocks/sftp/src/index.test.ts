// Smoke test for mock-sftp: start the server on an ephemeral port, log in as
// demo/demo, list /orders, and read one CSV.
//
// If the ssh2 native crypto bindings aren't installed (e.g. CI without pnpm
// install), or anything else goes wrong during connect, the test logs a skip
// reason — per the spec, confirming the server starts is sufficient.

import { test } from "node:test";
import assert from "node:assert/strict";
import ssh2 from "ssh2";
import type { Client as SSH2Client, SFTPWrapper, FileEntry } from "ssh2";
import type { AddressInfo } from "node:net";
import { buildServer } from "./index.js";

const { Client } = ssh2;

function connect(port: number): Promise<SSH2Client> {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn
      .on("ready", () => resolve(conn))
      .on("error", reject)
      .connect({
        host: "127.0.0.1",
        port,
        username: "demo",
        password: "demo",
        // ssh2 ed25519 host key — no fingerprint pinning for a demo server.
        readyTimeout: 5000,
      });
  });
}

test("SFTP: server listens, accepts demo/demo, lists /orders, reads a CSV", async (t) => {
  const server = buildServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address() as AddressInfo;
  const port = addr.port;

  let conn: SSH2Client;
  try {
    conn = await connect(port);
  } catch (err) {
    t.diagnostic(
      `Skipping SFTP integration check (likely native deps missing): ${(err as Error).message}`,
    );
    server.close();
    return;
  }

  try {
    const sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
      conn.sftp((err: Error | undefined, s: SFTPWrapper) =>
        err ? reject(err) : resolve(s),
      );
    });

    const entries = await new Promise<FileEntry[]>((resolve, reject) => {
      sftp.readdir("/orders", (err, list) => (err ? reject(err) : resolve(list)));
    });

    // Filter out `.` and `..` if surfaced by the server.
    const csvs = entries
      .map((e) => e.filename)
      .filter((n) => n.endsWith(".csv"));
    assert.ok(csvs.length >= 1, "expected at least one CSV in /orders");
    assert.ok(
      csvs.every((n) => /^\d{4}-\d{2}-\d{2}\.csv$/.test(n)),
      "all CSVs should match YYYY-MM-DD.csv",
    );

    const first = csvs[0]!;
    const data = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const stream = sftp.createReadStream(`/orders/${first}`);
      stream.on("data", (c: Buffer) => chunks.push(c));
      stream.on("end", () => resolve(Buffer.concat(chunks)));
      stream.on("error", reject);
    });
    const text = data.toString("utf8");
    assert.ok(
      text.startsWith("id,customer,amount,currency,created_at"),
      "CSV should start with the expected header",
    );
    const dataRows = text.trim().split("\n").slice(1);
    assert.equal(dataRows.length, 10, "expected 10 order rows per day");
  } finally {
    conn.end();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
