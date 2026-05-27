import clsx from 'clsx';
import type { IntegrationState, RunStatus } from '@/lib/types';

type Variant = IntegrationState | RunStatus;

const PALETTE: Record<string, string> = {
  // Integration states
  Draft: 'bg-gray-500 text-gray-100',
  Generating: 'bg-blue-600 text-white animate-pulse',
  Tested: 'bg-amber-600 text-white',
  Approved: 'bg-green-600 text-white',
  Building: 'bg-blue-600 text-white',
  Deployed: 'bg-green-700 text-white',
  Running: 'bg-green-500 text-white',
  Degraded: 'bg-red-600 text-white',
  Retired: 'bg-gray-700 text-gray-300',
  // Run statuses
  pending: 'bg-gray-500 text-gray-100',
  running: 'bg-blue-600 text-white animate-pulse',
  succeeded: 'bg-green-600 text-white',
  failed: 'bg-red-600 text-white',
  timeout: 'bg-amber-600 text-white',
};

export function StatusPill({
  status,
  size = 'md',
  className,
}: {
  status: Variant | string;
  size?: 'sm' | 'md';
  className?: string;
}) {
  const palette = PALETTE[status] ?? 'bg-gray-600 text-gray-100';
  return (
    <span
      className={clsx(
        'inline-flex items-center rounded-full font-medium',
        size === 'sm'
          ? 'px-2 py-0.5 text-[10px]'
          : 'px-2.5 py-0.5 text-xs',
        palette,
        className,
      )}
    >
      {status}
    </span>
  );
}
