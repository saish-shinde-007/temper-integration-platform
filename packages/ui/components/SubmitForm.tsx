'use client';

import clsx from 'clsx';
import { ArrowUp, Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { api } from '@/lib/api';
import type { Trigger } from '@/lib/types';

const DEFAULT_DESCRIPTION = '';

type TriggerKind = 'cron' | 'webhook' | 'sftp';

export function SubmitForm() {
  const router = useRouter();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [description, setDescription] = useState(DEFAULT_DESCRIPTION);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [triggerKind, setTriggerKind] = useState<TriggerKind>('cron');
  const [cron, setCron] = useState('*/15 * * * *');
  const [webhookPath, setWebhookPath] = useState('/incoming');
  const [sftpHost, setSftpHost] = useState('sftp.example.com');
  const [sftpPort, setSftpPort] = useState(22);
  const [sftpPath, setSftpPath] = useState('/inbox');
  const [sftpPattern, setSftpPattern] = useState('*.csv');

  // Auto-resize the textarea as content grows.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 320) + 'px';
  }, [description]);

  const buildTrigger = (): Trigger => {
    if (triggerKind === 'cron') {
      return { type: 'cron', expression: cron };
    }
    if (triggerKind === 'webhook') {
      return { type: 'webhook', path: webhookPath };
    }
    return {
      type: 'sftp',
      host: sftpHost,
      port: sftpPort,
      path: sftpPath,
      pattern: sftpPattern,
    };
  };

  const deriveName = (desc: string) => {
    const firstLine = desc.split(/[\n.]/)[0]?.trim() ?? '';
    if (!firstLine) return 'Untitled integration';
    return firstLine.length > 80
      ? firstLine.slice(0, 77) + '…'
      : firstLine;
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    const trimmed = description.trim();
    if (trimmed.length < 10) {
      setError('Describe the integration in a little more detail.');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const integration = await api.createIntegration({
        name: deriveName(trimmed),
        description: trimmed,
        trigger: buildTrigger(),
      });
      // Kick off the Temporal workflow immediately so the integration walks
      // Draft → Generating → Tested on its own. Without this it sits in
      // Draft forever and the user wonders why nothing happens.
      try {
        await api.test(integration.id);
      } catch {
        // Don't block navigation if the test trigger fails — the user can
        // hit it from the detail page if they need to.
      }
      router.push(`/integrations/${integration.id}`);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to submit.',
      );
      setSubmitting(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void onSubmit(e as unknown as FormEvent);
    }
  };

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-red-300">
          {error}
        </div>
      )}

      <div className="relative">
        <textarea
          ref={textareaRef}
          rows={1}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Describe the integration you want to build…"
          disabled={submitting}
          className={clsx(
            'w-full resize-none rounded-2xl border border-bg-border bg-bg-input',
            'px-5 py-4 pr-14 text-[15px] leading-relaxed text-text placeholder:text-text-muted',
            'focus:border-bg-border focus:outline-none focus:ring-1 focus:ring-bg-border',
            'disabled:opacity-60',
          )}
        />
        <button
          type="submit"
          disabled={submitting || description.trim().length === 0}
          className={clsx(
            'absolute bottom-3 right-3 inline-flex h-9 w-9 items-center justify-center rounded-lg',
            'bg-accent text-black hover:bg-accent-hover',
            'disabled:cursor-not-allowed disabled:bg-bg-border disabled:text-text-muted',
            'transition-colors',
          )}
          aria-label="Submit"
        >
          {submitting ? (
            <Loader2 size={18} className="animate-spin" />
          ) : (
            <ArrowUp size={18} />
          )}
        </button>
      </div>

      <TriggerConfig
        kind={triggerKind}
        setKind={setTriggerKind}
        cron={cron}
        setCron={setCron}
        webhookPath={webhookPath}
        setWebhookPath={setWebhookPath}
        sftpHost={sftpHost}
        setSftpHost={setSftpHost}
        sftpPort={sftpPort}
        setSftpPort={setSftpPort}
        sftpPath={sftpPath}
        setSftpPath={setSftpPath}
        sftpPattern={sftpPattern}
        setSftpPattern={setSftpPattern}
      />
    </form>
  );
}

function TriggerConfig(props: {
  kind: TriggerKind;
  setKind: (k: TriggerKind) => void;
  cron: string;
  setCron: (v: string) => void;
  webhookPath: string;
  setWebhookPath: (v: string) => void;
  sftpHost: string;
  setSftpHost: (v: string) => void;
  sftpPort: number;
  setSftpPort: (v: number) => void;
  sftpPath: string;
  setSftpPath: (v: string) => void;
  sftpPattern: string;
  setSftpPattern: (v: string) => void;
}) {
  const {
    kind,
    setKind,
    cron,
    setCron,
    webhookPath,
    setWebhookPath,
    sftpHost,
    setSftpHost,
    sftpPort,
    setSftpPort,
    sftpPath,
    setSftpPath,
    sftpPattern,
    setSftpPattern,
  } = props;

  return (
    <div className="rounded-2xl border border-bg-border bg-bg-surface px-4 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <label className="text-xs font-medium text-text-secondary">
          Trigger
        </label>
        <div className="inline-flex rounded-lg border border-bg-border bg-bg p-0.5">
          {(['cron', 'webhook', 'sftp'] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setKind(k)}
              className={clsx(
                'rounded-md px-3 py-1 text-xs font-medium transition-colors',
                kind === k
                  ? 'bg-bg-surface text-text'
                  : 'text-text-secondary hover:text-text',
              )}
            >
              {k}
            </button>
          ))}
        </div>

        {kind === 'cron' && (
          <Field label="Expression">
            <input
              type="text"
              value={cron}
              onChange={(e) => setCron(e.target.value)}
              className={inputClass}
              placeholder="*/15 * * * *"
            />
          </Field>
        )}

        {kind === 'webhook' && (
          <Field label="Path">
            <input
              type="text"
              value={webhookPath}
              onChange={(e) => setWebhookPath(e.target.value)}
              className={inputClass}
              placeholder="/incoming"
            />
          </Field>
        )}

        {kind === 'sftp' && (
          <>
            <Field label="Host">
              <input
                type="text"
                value={sftpHost}
                onChange={(e) => setSftpHost(e.target.value)}
                className={inputClass}
              />
            </Field>
            <Field label="Port">
              <input
                type="number"
                value={sftpPort}
                onChange={(e) =>
                  setSftpPort(Number(e.target.value) || 22)
                }
                className={clsx(inputClass, 'w-20')}
              />
            </Field>
            <Field label="Path">
              <input
                type="text"
                value={sftpPath}
                onChange={(e) => setSftpPath(e.target.value)}
                className={inputClass}
              />
            </Field>
            <Field label="Pattern">
              <input
                type="text"
                value={sftpPattern}
                onChange={(e) => setSftpPattern(e.target.value)}
                className={inputClass}
              />
            </Field>
          </>
        )}
      </div>
    </div>
  );
}

const inputClass =
  'rounded-md border border-bg-border bg-bg px-2.5 py-1 text-xs text-text font-mono focus:outline-none focus:ring-1 focus:ring-bg-border placeholder:text-text-muted';

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="inline-flex items-center gap-2">
      <span className="text-[11px] text-text-muted">{label}</span>
      {children}
    </label>
  );
}
