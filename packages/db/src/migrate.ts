// Database migration / schema bootstrap.
// Reads schema.sql from disk and applies it idempotently. Safe to run on
// every startup because every statement is `CREATE ... IF NOT EXISTS`.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PoolClient } from "pg";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Apply the bundled schema.sql to the given client connection.
 * Idempotent — uses CREATE TABLE IF NOT EXISTS everywhere.
 *
 * Caller passes a PoolClient (typically from pool.connect()) so the whole
 * schema is applied on one connection without grabbing fresh ones for
 * each statement.
 */
export async function applySchema(client: PoolClient): Promise<void> {
  // schema.sql lives next to this file. At build time it ends up in dist/
  // alongside the compiled JS; in dev (tsx) it sits in src/.
  const candidates = [
    join(__dirname, "schema.sql"),
    join(__dirname, "..", "src", "schema.sql"),
  ];

  let sql: string | undefined;
  for (const path of candidates) {
    try {
      sql = readFileSync(path, "utf8");
      break;
    } catch {
      // try the next candidate
    }
  }
  if (!sql) {
    throw new Error(
      `Could not locate schema.sql in any of: ${candidates.join(", ")}`,
    );
  }

  // pg's client.query accepts multi-statement SQL when no parameters are
  // bound, so we can run the whole schema in a single round-trip.
  await client.query(sql);
}
