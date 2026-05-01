import { type ButtonHTMLAttributes, type ReactNode } from 'react';
import { twMerge } from 'tailwind-merge';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  children: ReactNode;
}

const variants = {
  primary: 'bg-accent hover:bg-accent-hover text-white shadow-glow-sm',
  secondary: 'bg-bg-elev hover:bg-border text-white border border-border',
  ghost: 'bg-transparent hover:bg-bg-elev text-white',
  danger: 'bg-red-900 hover:bg-red-800 text-white',
};

const sizes = {
  sm: 'px-3 py-1.5 text-sm',
  md: 'px-4 py-2 text-sm',
  lg: 'px-6 py-3 text-base',
};

export function Button({ variant = 'primary', size = 'md', className, children, ...rest }: ButtonProps) {
  return (
    <button
      {...rest}
      className={twMerge(
        'rounded-md font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-accent/50',
        variants[variant], sizes[size], className,
      )}
    >
      {children}
    </button>
  );
}
