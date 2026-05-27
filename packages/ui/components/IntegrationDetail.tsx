'use client';

import clsx from 'clsx';
import {
  Check,
  RefreshCw,
  Rocket,
  X,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type {
  Integration,
  IntegrationVersion,
  Run,
} from '@/lib/types';
import { Button } from './Button';
import { CodeBlock } from './CodeBlock';
import { LogStream } from './LogStream';
import { StatusPill } from './StatusPill';

type TabKey =
  | 'description'
  | 'code'
  | 'logs'
  | 'output'
  | 'runs';

const TABS: { key: TabKey; label: string }[] = [
  { key: 'description', label: 'Description' },
  { key: 'code', label: 'Generated code' },
  { key: 'logs', label: 'Sandbox logs' },
  { key: 'output', label: 'Output' },
  { key: 'runs', label: 'Runs history' },
];

// Augmented shape: API may attach the current version inline. We accept it
// optionally to stay tolerant of the wire format.
type IntegrationWithVersion = Integration & {
  current_version?: IntegrationVersion | null;
  last_output?: string | null;
};

export function IntegrationDetail({
  integration,
  runs,
}: {
  integration: IntegrationWithVersion;
  runs: Run[];
}) {
  const router = useRouter();
  const [tab, setTab] = useState<TabKey>('description');
  const [busy, setBusy] = useState<null | 'approve' | 'reject' | 'regenerate' | 'deploy'>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  const isTested = integration.state === 'Tested';
  const isDeployed =
    integration.state === 'Deployed' ||
    integration.state === 'Running' ||
    integration.state === 'Degraded';
  const isApproved = integration.state === 'Approved';

  // Auto-refresh the page while the integration is in a transitional state.
  // Without this, the server-rendered page would only show stale data and the
  // user would have to manually refresh to see state pill, banner, generated
  // code, and runs update as the workflow progresses.
  //
  // Polls every 2.5s while transitional; stops once it settles on a quiescent
  // state (Tested awaits human approval; Deployed/Running/Degraded/Retired/
  // Draft are stable). Cleanup on unmount or state change.
  useEffect(() => {
    const transitional: Integration['state'][] = [
      'Generating',
      'Approved',
      'Building',
    ];
    if (!transitional.includes(integration.state)) return;
    const id = setInterval(() => router.refresh(), 2500);
    return () => clearInterval(id);
  }, [integration.state, router]);

  const onApprove = async () => {
    // current_version_id is only set after Deploy. On Tested state it's still
    // null — but the inlined current_version (from the API's fallback to the
    // latest version) has the id we want to approve.
    const versionId =
      integration.current_version_id ?? integration.current_version?.id;
    if (!versionId) {
      setError('No version available to approve. Try Regenerate.');
      return;
    }
    setBusy('approve');
    setError(null);
    try {
      await api.approve(integration.id, versionId);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Approve failed.');
    } finally {
      setBusy(null);
    }
  };

  const onReject = async () => {
    setBusy('reject');
    setError(null);
    try {
      await api.reject(integration.id);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Reject failed.');
    } finally {
      setBusy(null);
    }
  };

  const onRegenerate = async () => {
    // Regenerate = re-submit by hitting createIntegration with the same
    // description + trigger. The API spec for "regenerate" isn't defined
    // here; we fall back to a fresh create and navigate to it.
    setBusy('regenerate');
    setError(null);
    try {
      const fresh = await api.createIntegration({
        name: integration.name,
        description: integration.description,
        trigger: integration.trigger,
      });
      // Same as the submit form: trigger /test so the new integration walks
      // Draft → Generating → Tested instead of sitting forever.
      try {
        await api.test(fresh.id);
      } catch {
        /* navigate even if test trigger fails */
      }
      router.push(`/integrations/${fresh.id}`);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Regenerate failed.',
      );
      setBusy(null);
    }
  };

  const onDeploy = async () => {
    setBusy('deploy');
    setError(null);
    try {
      await api.deploy(integration.id);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Deploy failed.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex w-full flex-col gap-6">
      {/* Header */}
      <div className="flex flex-col gap-2">
        <div className="text-xs text-text-muted">
          <span>Integrations</span>
          <span className="px-1.5">/</span>
          <span className="font-mono text-text-secondary">
            {integration.id.slice(0, 12)}
          </span>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">
              {integration.name}
            </h1>
            <StatusPill status={integration.state} />
          </div>
          <div className="text-xs text-text-muted">
            Updated{' '}
            {new Date(integration.updated_at).toLocaleString()}
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="border-b border-bg-border">
        <div className="flex flex-wrap gap-1">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={clsx(
                'relative px-3 py-2 text-sm transition-colors',
                tab === t.key
                  ? 'text-text'
                  : 'text-text-secondary hover:text-text',
              )}
            >
              {t.label}
              {tab === t.key && (
                <span className="absolute inset-x-2 -bottom-px h-px bg-accent" />
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Approval-required banner */}
      {isTested && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-200 flex items-start gap-3">
          <span className="text-lg leading-none">⏸</span>
          <div className="flex-1">
            <div className="font-medium text-amber-100">Awaiting your approval</div>
            <div className="mt-1 text-amber-200/80">
              Generation passed sandbox validation. Review the generated code and sandbox output below, then click <span className="font-medium text-amber-100">Approve</span> to walk this integration through Building → Deployed. Click <span className="font-medium text-amber-100">Reject</span> to send it back to Draft.
            </div>
          </div>
        </div>
      )}

      {/* Body */}
      <div>
        {tab === 'description' && (
          <DescriptionPane integration={integration} />
        )}
        {tab === 'code' && (
          <CodePane version={integration.current_version} />
        )}
        {tab === 'logs' && (
          <LogStream integrationId={integration.id} />
        )}
        {tab === 'output' && (
          <OutputPane runs={runs} lastOutput={integration.last_output} />
        )}
        {tab === 'runs' && <RunsTable runs={runs} />}
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-red-300">
          {error}
        </div>
      )}

      {/* Action bar */}
      {isTested && (
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-bg-border pt-4">
          <Button
            variant="ghost"
            size="md"
            onClick={onReject}
            disabled={busy !== null}
            leftIcon={<X size={14} />}
          >
            Reject
          </Button>
          <Button
            variant="ghost"
            size="md"
            onClick={onRegenerate}
            disabled={busy !== null}
            leftIcon={<RefreshCw size={14} />}
          >
            Regenerate
          </Button>
          <Button
            variant="primary"
            size="md"
            onClick={onApprove}
            disabled={
              busy !== null ||
              !(
                integration.current_version_id ?? integration.current_version?.id
              )
            }
            leftIcon={<Check size={14} />}
          >
            {busy === 'approve' ? 'Approving…' : 'Approve'}
          </Button>
        </div>
      )}

      {isApproved && (
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-bg-border pt-4">
          <Button
            variant="primary"
            size="md"
            onClick={onDeploy}
            disabled={busy !== null}
            leftIcon={<Rocket size={14} />}
          >
            {busy === 'deploy' ? 'Deploying…' : 'Deploy'}
          </Button>
        </div>
      )}

      {isDeployed && runs.length === 0 && (
        <div className="rounded-lg border border-bg-border bg-bg-surface px-4 py-3 text-sm text-text-secondary">
          Deployed. Waiting for the first run…
        </div>
      )}
    </div>
  );
}

function DescriptionPane({
  integration,
}: {
  integration: IntegrationWithVersion;
}) {
  return (
    <div className="flex flex-col gap-5">
      <div className="rounded-lg border border-bg-border bg-bg-surface p-5">
        <div className="text-[11px] uppercase tracking-wider text-text-muted">
          Description
        </div>
        <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-text">
          {integration.description}
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <InfoCard label="Trigger">
          <TriggerSummary trigger={integration.trigger} />
        </InfoCard>
        <InfoCard label="State">
          <StatusPill status={integration.state} />
        </InfoCard>
        {integration.current_version?.declared_endpoints?.length ? (
          <InfoCard label="Declared endpoints">
            <ul className="flex flex-col gap-1 font-mono text-xs">
              {integration.current_version.declared_endpoints.map(
                (e) => (
                  <li key={e} className="text-text-secondary">
                    {e}
                  </li>
                ),
              )}
            </ul>
          </InfoCard>
        ) : null}
        {integration.current_version?.declared_secrets?.length ? (
          <InfoCard label="Declared secrets">
            <ul className="flex flex-wrap gap-1.5 font-mono text-xs">
              {integration.current_version.declared_secrets.map(
                (s) => (
                  <li
                    key={s}
                    className="rounded-md border border-bg-border bg-bg px-2 py-0.5 text-text-secondary"
                  >
                    {s}
                  </li>
                ),
              )}
            </ul>
          </InfoCard>
        ) : null}
      </div>
    </div>
  );
}

function TriggerSummary({
  trigger,
}: {
  trigger: Integration['trigger'];
}) {
  if (trigger.type === 'cron') {
    return (
      <div className="flex items-baseline gap-2">
        <span className="text-[11px] uppercase text-text-muted">
          cron
        </span>
        <code className="font-mono text-sm">{trigger.expression}</code>
      </div>
    );
  }
  if (trigger.type === 'webhook') {
    return (
      <div className="flex items-baseline gap-2">
        <span className="text-[11px] uppercase text-text-muted">
          webhook
        </span>
        <code className="font-mono text-sm">{trigger.path}</code>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-0.5 font-mono text-xs">
      <div>
        <span className="text-text-muted">sftp </span>
        {trigger.host}:{trigger.port}
      </div>
      <div className="text-text-secondary">
        {trigger.path} • {trigger.pattern}
      </div>
    </div>
  );
}

function CodePane({
  version,
}: {
  version?: IntegrationVersion | null;
}) {
  if (!version) {
    return (
      <div className="rounded-lg border border-bg-border bg-bg-surface px-4 py-8 text-center text-sm text-text-muted">
        No generated code yet.
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-text-muted">
        <span>
          <span className="text-text-muted">sha256: </span>
          <span className="font-mono text-text-secondary">
            {version.sha256.slice(0, 16)}…
          </span>
        </span>
        <span>
          <span className="text-text-muted">created: </span>
          <span className="text-text-secondary">
            {new Date(version.created_at).toLocaleString()}
          </span>
        </span>
      </div>
      <CodeBlock
        code={version.source_code}
        language="typescript"
      />
    </div>
  );
}

function OutputPane({
  runs,
  lastOutput,
}: {
  runs: Run[];
  lastOutput?: string | null;
}) {
  const mostRecent = runs[0];
  const payload =
    mostRecent?.output_payload ?? lastOutput ?? null;

  if (!payload) {
    return (
      <div className="rounded-lg border border-bg-border bg-bg-surface px-4 py-8 text-center text-sm text-text-muted">
        No output produced yet.
      </div>
    );
  }

  let pretty = payload;
  try {
    pretty = JSON.stringify(JSON.parse(payload), null, 2);
  } catch {
    // Not JSON — keep raw.
  }
  return <CodeBlock code={pretty} language="json" />;
}

function RunsTable({ runs }: { runs: Run[] }) {
  if (runs.length === 0) {
    return (
      <div className="rounded-lg border border-bg-border bg-bg-surface px-4 py-8 text-center text-sm text-text-muted">
        No runs recorded.
      </div>
    );
  }
  return (
    <div className="overflow-hidden rounded-lg border border-bg-border">
      <table className="w-full text-sm">
        <thead className="bg-bg-surface text-[11px] uppercase tracking-wider text-text-muted">
          <tr>
            <Th>Started</Th>
            <Th>Status</Th>
            <Th>Duration</Th>
            <Th>Exit</Th>
            <Th>Trigger</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-bg-border">
          {runs.map((run) => (
            <tr key={run.id} className="bg-bg">
              <Td>
                <span className="font-mono text-xs text-text-secondary">
                  {new Date(run.started_at).toLocaleString()}
                </span>
              </Td>
              <Td>
                <StatusPill status={run.status} size="sm" />
              </Td>
              <Td>
                {run.duration_ms != null ? (
                  <span className="font-mono text-xs">
                    {run.duration_ms}ms
                  </span>
                ) : (
                  <span className="text-text-muted">—</span>
                )}
              </Td>
              <Td>
                {run.exit_code != null ? (
                  <span className="font-mono text-xs">
                    {run.exit_code}
                  </span>
                ) : (
                  <span className="text-text-muted">—</span>
                )}
              </Td>
              <Td>
                <span className="font-mono text-xs text-text-secondary">
                  {run.trigger_source}
                </span>
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="px-4 py-2 text-left font-medium">{children}</th>
  );
}

function Td({ children }: { children: React.ReactNode }) {
  return <td className="px-4 py-2 align-middle">{children}</td>;
}

function InfoCard({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-bg-border bg-bg-surface p-4">
      <div className="mb-2 text-[11px] uppercase tracking-wider text-text-muted">
        {label}
      </div>
      <div>{children}</div>
    </div>
  );
}
