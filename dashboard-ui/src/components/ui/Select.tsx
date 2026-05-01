import { type SelectHTMLAttributes } from 'react';
import { twMerge } from 'tailwind-merge';

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...rest}
      className={twMerge(
        'w-full rounded-md bg-bg-elev border border-border text-white px-3 py-2 text-sm',
        'focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent',
        'disabled:opacity-50',
        className,
      )}
    >
      {children}
    </select>
  );
}
