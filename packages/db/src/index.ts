// Public surface of @temper/db.
// Consumers should import everything they need from this module; the
// internal file layout is not part of the contract.

export {
  openDb,
  closeDb,
  Repo,
  createTenant,
  getTenant,
  createUser,
} from "./repo.js";
export type {
  AuditLoggerFactory,
  CreateIntegrationInput,
  CreateRunInput,
  UpdateRunPatch,
} from "./repo.js";

export { applySchema } from "./migrate.js";

export { AuditLogger } from "./audit.js";

export { SecretsManager, resolveMasterKey } from "./secrets.js";

export { seedDemoTenant } from "./seed.js";
export type { SeedResult } from "./seed.js";
