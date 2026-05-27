'use client';

import clsx from 'clsx';
import { Check, Copy } from 'lucide-react';
import { useState } from 'react';

export function CodeBlock({
  code,
  language,
  className,
}: {
  code: string;
  language?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Ignore clipboard errors silently — copy is a nicety.
    }
  };

  return (
    <div
      className={clsx(
        'group relative rounded-lg border border-bg-border bg-black/40',
        className,
      )}
    >
      <div className="flex items-center justify-between border-b border-bg-border px-3 py-1.5">
        <span className="font-mono text-[11px] uppercase tracking-wide text-text-muted">
          {language ?? 'code'}
        </span>
        <button
          type="button"
          onClick={onCopy}
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-text-secondary hover:bg-bg-surface hover:text-text"
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="overflow-x-auto p-4 font-mono text-sm leading-relaxed text-text">
        <code>{code}</code>
      </pre>
    </div>
  );
}
