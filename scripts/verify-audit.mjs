import { openDb, AuditLogger } from "../packages/db/dist/index.js";
const db = openDb("./data/temper.db");
const audit = new AuditLogger(db, "tenant-demo");
const events = audit.list();
const verifyResult = audit.verify();
console.log(`Events: ${events.length}`);
console.log(`Hash chain verify(): ${JSON.stringify(verifyResult)}`);
console.log("");
console.log("Last 3 events:");
for (const e of events.slice(-3)) {
  console.log(`  ${e.type} @ ${e.created_at}`);
  console.log(`    hash: ${e.hash.slice(0,16)}... prev: ${e.prev_hash.slice(0,16)}...`);
}
