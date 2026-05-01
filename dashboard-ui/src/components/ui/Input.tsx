import { type InputHTMLAttributes } from 'react';
import { twMerge } from 'tailwind-merge';

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...rest}
      className={twMerge(
        'input-premium w-full rounded-lg text-white px-3.5 py-2.5 text-sm',
        'placeholder:text-muted/80 focus:outline-none',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        className,
      )}
    />
  );
}
