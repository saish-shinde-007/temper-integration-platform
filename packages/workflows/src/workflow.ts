// Temper integration lifecycle workflow.
//
// Models the full Draft -> Generating -> Tested -> Approved -> Building ->
// Deployed flow as a single deterministic Temporal workflow. The workflow
// itself owns NO side effects — all DB writes, LLM calls and Docker work
// happen in activities (see ./activities.ts). The workflow only sequences
// them and waits for the human-approval signal.
//
// Why a workflow at all (vs. a long-lived process or a cron poller)?
//   - The approval step can sit idle for hours, days, even weeks. A
//     workflow process can sleep across worker restarts without losing
//     state. A plain Node process can't.
//   - Every activity is automatically retried and is durably recorded;
//     the workflow can survive a crash mid-sandbox and resume from the
//     last activity boundary.
//   - The same workflow code runs on every cloud — there's no per-cloud
//     re-implementation of the orchestration logic.

import {
  proxyActivities,
  defineSignal,
  setHandler,
  condition,
  log,
} from "@temporalio/workflow";
import type * as activities from "./activities.js";

// Activities are proxied with a generous start-to-close timeout. The
// real bound for the slow activity (sandbox execution) lives inside the
// activity itself; the proxy timeout is just a safety net for hung calls.
// We retry up to 3 times on transient failures (network blips, sqlite
// busy, dockerode timeouts) — beyond that we bubble the error to the
// workflow which then transitions back to Draft via markFailed.
const {
  generateCode,
  runSandbox,
  buildImage,
  deployToRunner,
  markFailed,
  updateIntegrationState,
} = proxyActivities<typeof activities>({
  startToCloseTimeout: "5 minutes",
  retry: { maximumAttempts: 3 },
});

// Signals the API sends from the approval UI.
//   - approve: { versionId } — caller picks which version to promote.
//   - reject: { reason? } — moves the integration back to Draft.
//   - deploy: reserved for re-deploying an already-Tested version without
//     a fresh approval. Wired up as a signal handler but not yet used in
//     the flow below; the API can send it once we add that path.
export const approveSignal = defineSignal<[{ versionId: string }]>("approve");
export const rejectSignal = defineSignal<[{ reason?: string }]>("reject");
export const deploySignal = defineSignal<[]>("deploy");

export interface IntegrationWorkflowInput {
  integrationId: string;
  tenantId: string;
}

export async function integrationWorkflow(
  input: IntegrationWorkflowInput,
): Promise<void> {
  // Signal state is captured into a small mutable object whose properties
  // get reassigned from inside the signal handlers.
  //
  // Why an object rather than three top-level `let` variables? TypeScript's
  // control-flow narrowing sees only the assignment to `null` and concludes
  // the closure can never be widened back — handlers fire asynchronously
  // and TS can't trace that. Reading through an object property bypasses
  // that narrowing while keeping the runtime semantics identical.
  type Approved = { versionId: string };
  type Rejected = { reason?: string };
  const sig: {
    approved: Approved | null;
    rejected: Rejected | null;
    redeploy: boolean;
  } = {
    approved: null,
    rejected: null,
    redeploy: false,
  };

  setHandler(approveSignal, (data) => {
    sig.approved = data;
  });
  setHandler(rejectSignal, (data) => {
    sig.rejected = data;
  });
  setHandler(deploySignal, () => {
    sig.redeploy = true;
  });

  try {
    // ---- Generate ----
    await updateIntegrationState(input, "Generating");
    const generated = await generateCode(input);

    // ---- Test in sandbox ----
    // The sandbox returns a SandboxResult; we treat anything other than
    // 'succeeded' as a generation-quality failure and drop back to Draft
    // so the user can edit and resubmit. We do NOT auto-retry generation;
    // that's a deliberate policy call — silently re-rolling code on every
    // test failure burns LLM quota and surprises the user.
    const sandboxResult = await runSandbox({
      ...input,
      versionId: generated.versionId,
    });
    if (sandboxResult.status !== "succeeded") {
      await updateIntegrationState(input, "Draft");
      log.warn("Sandbox test failed, back to Draft", { sandboxResult });
      return;
    }

    await updateIntegrationState(input, "Tested");

    // ---- Wait for approval ----
    // 24h timeout for the demo; in production this would be days or weeks.
    // The workflow remains durably suspended across worker restarts — that
    // is the whole reason this is a Temporal workflow and not a script.
    await condition(
      () => sig.approved !== null || sig.rejected !== null,
      "24 hours",
    );

    if (sig.rejected) {
      await updateIntegrationState(input, "Draft");
      log.info("Rejected, back to Draft", { reason: sig.rejected.reason });
      return;
    }

    if (!sig.approved) {
      // Timed out without either signal. Back to Draft so it doesn't
      // sit in 'Tested' forever pretending to be ready.
      await updateIntegrationState(input, "Draft");
      log.warn("Approval timed out, back to Draft");
      return;
    }

    // ---- Build + deploy ----
    // We move to 'Approved' first (the human said yes), then to 'Building'
    // for the duration of the buildImage call, then to 'Deployed' once
    // deployToRunner has actually wired up the runner. The intermediate
    // states are observable from the UI — the user sees progress.
    const approvedVersionId = sig.approved.versionId;
    await updateIntegrationState(input, "Approved");
    await updateIntegrationState(input, "Building");
    const built = await buildImage({
      ...input,
      versionId: approvedVersionId,
    });
    await deployToRunner({
      ...input,
      versionId: approvedVersionId,
      imageTag: built.imageTag,
    });
    await updateIntegrationState(input, "Deployed");

    // The deploySignal handler flips `redeploy` for future use; we read
    // it here to silence the unused-variable warning and document intent.
    if (sig.redeploy) {
      log.info("Redeploy signal received post-Deployed; no-op for now");
    }
  } catch (err) {
    // Any activity throwing after all retries lands here. markFailed is
    // itself an activity (and itself retried), so the only way state can
    // be stuck mid-flow is if the worker is down for the entire retry
    // budget — at which point a human has to intervene anyway.
    await markFailed(input, String(err));
    throw err;
  }
}
