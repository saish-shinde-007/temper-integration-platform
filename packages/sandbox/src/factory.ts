// Factory picking between local Docker sandbox and remote E2B sandbox.
//
// Precedence:
//   1. SANDBOX_PROVIDER=e2b   → E2BSandboxExecutor
//   2. SANDBOX_PROVIDER=docker → SandboxExecutor (Docker)
//   3. E2B_API_KEY is set     → E2BSandboxExecutor (auto)
//   4. Otherwise              → SandboxExecutor (Docker, local dev)

import Docker from "dockerode";
import type { SandboxAPI } from "@temper/shared";
import { SandboxExecutor, type SandboxExecutorOptions } from "./executor.js";
import { E2BSandboxExecutor } from "./e2b-executor.js";

export type SandboxProvider = "docker" | "e2b" | "auto";

export interface CreateSandboxOptions {
  provider?: SandboxProvider;
  docker?: SandboxExecutorOptions;
}

export function createSandboxExecutor(opts: CreateSandboxOptions = {}): SandboxAPI {
  const requested =
    opts.provider ??
    (process.env.SANDBOX_PROVIDER as SandboxProvider | undefined) ??
    "auto";

  if (requested === "e2b") {
    if (!process.env.E2B_API_KEY) {
      throw new Error(
        "SANDBOX_PROVIDER=e2b but E2B_API_KEY is not set.",
      );
    }
    console.log("[sandbox] using E2BSandboxExecutor (Firecracker via E2B)");
    return new E2BSandboxExecutor();
  }

  if (requested === "docker") {
    console.log("[sandbox] using SandboxExecutor (hardened Docker, local dev)");
    return new SandboxExecutor(new Docker(), opts.docker);
  }

  // auto
  if (process.env.E2B_API_KEY) {
    console.log("[sandbox] auto: E2B_API_KEY detected, using E2BSandboxExecutor");
    return new E2BSandboxExecutor();
  }
  console.log("[sandbox] auto: no E2B key, using local Docker SandboxExecutor");
  return new SandboxExecutor(new Docker(), opts.docker);
}
