// Public surface for @temper/sandbox.
// Consumers (workflows, runner, tests) should import only from this entry point.

export { SandboxExecutor } from "./executor.js";
export type { SandboxExecutorOptions } from "./executor.js";

export { E2BSandboxExecutor, createReusableSandbox } from "./e2b-executor.js";
export type { E2BSandboxExecutorOptions } from "./e2b-executor.js";

export { createSandboxExecutor } from "./factory.js";
export type { SandboxProvider } from "./factory.js";

// Re-export the shared contract types so callers don't need to depend on
// @temper/shared directly just to talk to the sandbox.
export type {
  SandboxAPI,
  SandboxRequest,
  SandboxResult,
  EgressCall,
} from "@temper/shared";
