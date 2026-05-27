import Link from 'next/link';
import { Plus, Sparkles } from 'lucide-react';
import { api } from '@/lib/api';
import type { Integration } from '@/lib/types';
import { StatusPill } from './StatusPill';
import clsx from 'clsx';

async function safeList(): Promise<Integration[]> {
  try {
    return await api.listIntegrations();
  } catch {
    // API offline during development should not crash the shell.
    return [];
  }
}

export async function Sidebar({
  activeId,
}: {
  activeId?: string;
}) {
  const all = await safeList();
  // Hide Draft integrations by default — they're almost always failed
  // submissions kept in the DB for audit. Show them if the user is actively
  // viewing one (so the sidebar isn't confusingly empty when they navigate
  // straight to a Draft URL).
  const integrations = all.filter(
    (it) => it.state !== 'Draft' || it.id === activeId,
  );

  return (
    <aside className="hidden h-screen w-[280px] shrink-0 flex-col border-r border-bg-border bg-bg-surface md:flex">
      <div className="flex items-center gap-2 px-4 pt-5 pb-2">
        <div className="flex h-7 w-7 items-center justify-center rounded-md bg-accent/15 text-accent">
          <Sparkles size={16} />
        </div>
        <span className="text-sm font-semibold tracking-tight">
          Temper
        </span>
      </div>

      <div className="px-3 pt-3">
        <Link
          href="/"
          className="flex w-full items-center gap-2 rounded-lg border border-bg-border bg-bg px-3 py-2 text-sm font-medium text-text hover:bg-bg-border"
        >
          <Plus size={15} />
          New integration
        </Link>
      </div>

      <div className="px-3 pt-6 pb-2 text-[11px] font-medium uppercase tracking-wider text-text-muted">
        Recent
      </div>

      <nav className="flex-1 overflow-y-auto px-2 pb-4">
        {integrations.length === 0 ? (
          <div className="px-3 py-2 text-xs text-text-muted">
            No integrations yet.
          </div>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {integrations.map((it) => (
              <li key={it.id}>
                <Link
                  href={`/integrations/${it.id}`}
                  className={clsx(
                    'flex items-center justify-between gap-2 rounded-md px-3 py-2 text-sm transition-colors',
                    it.id === activeId
                      ? 'bg-bg-border text-text'
                      : 'text-text-secondary hover:bg-bg-border/60 hover:text-text',
                  )}
                >
                  <span className="truncate">{it.name}</span>
                  <StatusPill status={it.state} size="sm" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </nav>

      <div className="border-t border-bg-border px-4 py-3 text-[11px] text-text-muted">
        AI-generated integrations, sandboxed.
      </div>
    </aside>
  );
}
