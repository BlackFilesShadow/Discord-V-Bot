import { type ReactNode } from 'react';
import { twMerge } from 'tailwind-merge';

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={twMerge('kbd', className)}>{children}</span>;
}
