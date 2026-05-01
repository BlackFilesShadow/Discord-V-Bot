import { type SelectHTMLAttributes } from 'react';
import { twMerge } from 'tailwind-merge';

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...rest}
      className={twMerge(
        'input-premium w-full rounded-lg text-white px-3.5 py-2.5 text-sm appearance-none cursor-pointer',
        'focus:outline-none',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        className,
      )}
    >
      {children}
    </select>
  );
}
