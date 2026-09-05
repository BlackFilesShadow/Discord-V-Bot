import { type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { twMerge } from 'tailwind-merge';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline';
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
  children: ReactNode;
}

const variants = {
  primary: 'btn-premium-primary',
  secondary: 'btn-premium-secondary',
  outline: 'btn-premium-outline',
  ghost: 'btn-premium-ghost',
  danger: 'btn-premium-danger',
};

// Keep every visual variant on the shared 44px minimum-control contract.
// The old md:min-h-0 override collapsed small desktop buttons to 32px. The
// minimum height is deliberately kept on the primitive itself because the
// dashboard architecture/mobile contract relies on it in addition to the
// coarse-pointer CSS safety net.
const sizes = {
  sm: 'h-11 min-w-11 px-3.5 text-sm',
  md: 'h-11 min-w-11 px-4 text-sm',
  lg: 'h-12 min-w-12 px-6 text-base',
};

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  className,
  children,
  disabled,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      disabled={disabled || loading}
      className={twMerge(
        'inline-flex min-h-11 shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium',
        'disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:shadow-none',
        'focus-ring',
        variants[variant],
        sizes[size],
        className,
      )}
    >
      {loading && <Loader2 className="h-4 w-4 animate-spin" />}
      {children}
    </button>
  );
}
