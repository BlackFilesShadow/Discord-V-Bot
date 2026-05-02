import { twMerge } from 'tailwind-merge';

interface SkeletonProps {
  className?: string;
  /** Vorgefertigte Variante */
  variant?: 'text' | 'box' | 'avatar' | 'card';
  /** Anzahl wiederholter Skeletons (z. B. fuer Listen). */
  count?: number;
}

const variants: Record<NonNullable<SkeletonProps['variant']>, string> = {
  text:   'h-3 w-full rounded',
  box:    'h-24 w-full rounded-lg',
  avatar: 'h-10 w-10 rounded-full',
  card:   'h-32 w-full rounded-xl',
};

export function Skeleton({ className, variant = 'text', count = 1 }: SkeletonProps) {
  if (count === 1) return <div className={twMerge('skeleton', variants[variant], className)} />;
  return (
    <div className="space-y-2">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className={twMerge('skeleton', variants[variant], className)} />
      ))}
    </div>
  );
}
