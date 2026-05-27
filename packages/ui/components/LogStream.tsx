'use client';

import clsx from 'clsx';
import { useEffect, useRef, useState } from 'react';
import { API_BASE_URL, api } from '@/lib/api';

interface LogLine {
  ts: number;
  text: string;
  level?: 'info' | 'warn' | 'error';
}

type ConnState = 'connecting' | 'live' | 'idle' | 'lost';

export function LogStream({
  integrationId,
  className,
}: {
  integrationId: string;
  className?: string;
}) {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [state, setState] = useState<ConnState>('connecting');
  const scrollerRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    if (stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [lines]);

  useEffect(() => {
    let cancelled = false;
    let es: EventSource | null = null;
    let doneFired = false;

    async function setup() {
      // 1. Seed with historical run logs so the user sees something for
      //    finished integrations — not just an empty "waiting" placeholder.
      try {
        const runs = await api.listRuns(integrationId);
        if (cancelled) return;
        const seed: LogLine[] = [];
        for (const r of runs.slice(0, 5).reverse()) {
          const stamp = new Date(r.started_at).getTime();
          seed.push({
            ts: stamp,
            text: `--- run ${r.id.slice(0, 8)} (${r.status}, ${r.duration_ms ?? '?'} ms) ---`,
          });
          if (r.stdout) {
            for (const line of r.stdout.split('\n')) {
              if (line.trim()) seed.push({ ts: stamp, text: line });
            }
          }
          if (r.stderr) {
            for (const line of r.stderr.split('\n')) {
              if (line.trim()) seed.push({ ts: stamp, text: line, level: 'error' });
            }
          }
        }
        if (seed.length > 0) setLines(seed);
      } catch {
        /* no runs yet */
      }

      // 2. Open SSE for live updates. Server sends three event types:
      //      connected — handshake
      //      message   — log line (default)
      //      done      — integration is idle; close cleanly, don't retry
      const url = `${API_BASE_URL}/v1/integrations/${integrationId}/logs`;
      es = new EventSource(url, { withCredentials: false });

      es.addEventListener('connected', () => {
        if (cancelled) return;
        setState('live');
      });

      es.onmessage = (evt) => {
        if (cancelled) return;
        let text = evt.data;
        let level: LogLine['level'];
        try {
          const parsed = JSON.parse(evt.data);
          if (typeof parsed === 'string') {
            text = parsed;
          } else if (parsed && typeof parsed === 'object') {
            text = parsed.message ?? parsed.line ?? parsed.text ?? evt.data;
            level = parsed.level;
          }
        } catch {
          /* raw text */
        }
        setLines((prev) => [...prev, { ts: Date.now(), text, level }]);
      };

      es.addEventListener('done', () => {
        if (cancelled) return;
        doneFired = true;
        setState('idle');
        if (es) {
          es.close();
          es = null;
        }
      });

      es.onerror = () => {
        if (cancelled || doneFired) return;
        setState('lost');
      };
    }

    setup();
    return () => {
      cancelled = true;
      if (es) es.close();
    };
  }, [integrationId]);

  const onScroll = () => {
    const el = scrollerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    stickToBottomRef.current = atBottom;
  };

  const statusLabel: Record<ConnState, string> = {
    connecting: 'connecting…',
    live: 'live',
    idle: 'idle (no active run)',
    lost: 'connection lost — retrying…',
  };
  const statusDot: Record<ConnState, string> = {
    connecting: 'bg-text-muted',
    live: 'bg-accent',
    idle: 'bg-text-muted',
    lost: 'bg-red-500',
  };

  return (
    <div
      className={clsx(
        'overflow-hidden rounded-xl border border-bg-border bg-bg-elev',
        className,
      )}
    >
      <div className="flex items-center justify-between border-b border-bg-border px-3 py-1.5">
        <span className="font-mono text-[11px] uppercase tracking-wide text-text-muted">
          sandbox logs
        </span>
        <span className="inline-flex items-center gap-1.5 text-[11px] text-text-muted">
          <span className={clsx('h-1.5 w-1.5 rounded-full', statusDot[state])} />
          {statusLabel[state]}
        </span>
      </div>
      <div
        ref={scrollerRef}
        onScroll={onScroll}
        className="max-h-96 min-h-[12rem] overflow-y-auto p-4 font-mono text-xs leading-relaxed"
      >
        {lines.length === 0 ? (
          <div className="text-text-muted">
            {state === 'idle'
              ? 'No logs yet — submit /test or wait for a scheduled fire.'
              : state === 'connecting'
              ? 'Connecting…'
              : 'Waiting for sandbox output…'}
          </div>
        ) : (
          lines.map((line, idx) => (
            <div
              key={idx}
              className={clsx(
                'whitespace-pre-wrap',
                line.level === 'error' && 'text-red-400',
                line.level === 'warn' && 'text-amber-400',
                !line.level && 'text-text',
              )}
            >
              {line.text}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
