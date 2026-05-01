import { type InputHTMLAttributes } from 'react';
import { twMerge } from 'tailwind-merge';

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...rest}
      className={twMerge(
        'w-full rounded-md bg-bg-elev border border-border text-white px-3 py-2 text-sm',
        'placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent',
        'disabled:opacity-50',
        className,
      )}
    />
  );
}
