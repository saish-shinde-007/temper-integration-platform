'use client';

import clsx from 'clsx';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

type Variant = 'primary' | 'ghost' | 'danger' | 'subtle';

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: 'sm' | 'md';
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
}

const VARIANTS: Record<Variant, string> = {
  primary:
    'bg-accent text-black hover:bg-accent-hover disabled:bg-accent/40 disabled:text-black/60',
  ghost:
    'bg-transparent text-text hover:bg-bg-surface border border-bg-border',
  danger:
    'bg-transparent text-red-400 hover:bg-red-500/10 border border-red-500/30',
  subtle:
    'bg-bg-surface text-text hover:bg-bg-border border border-bg-border',
};

const SIZES = {
  sm: 'px-3 py-1.5 text-xs',
  md: 'px-4 py-2 text-sm',
};

export function Button({
  variant = 'primary',
  size = 'md',
  className,
  leftIcon,
  rightIcon,
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      className={clsx(
        'inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors',
        'focus:outline-none focus:ring-1 focus:ring-bg-border',
        'disabled:cursor-not-allowed',
        SIZES[size],
        VARIANTS[variant],
        className,
      )}
    >
      {leftIcon}
      {children}
      {rightIcon}
    </button>
  );
}
