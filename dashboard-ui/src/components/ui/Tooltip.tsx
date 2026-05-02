/**
 * Minimaler Tooltip auf Hover/Focus.
 *
 * Kein external Lib (Floating-UI etc.) — positioniert sich relativ zum
 * Anchor und nutzt CSS-Klasse `.tooltip` aus index.css. Gut genug fuer
 * Icon-Buttons in Topbar/Sidebar; nicht fuer komplexe Inhalte gedacht.
 */
import { useState, type ReactElement, type ReactNode, cloneElement, useId } from 'react';
import { twMerge } from 'tailwind-merge';

interface TooltipProps {
  content: ReactNode;
  side?: 'top' | 'bottom' | 'left' | 'right';
  /** Einzelnes interaktives Kind, dessen onMouseEnter/Focus wir verkleben. */
  children: ReactElement;
  className?: string;
}

const sideCls: Record<NonNullable<TooltipProps['side']>, string> = {
  top:    'bottom-full mb-1 left-1/2 -translate-x-1/2',
  bottom: 'top-full   mt-1 left-1/2 -translate-x-1/2',
  left:   'right-full mr-1 top-1/2  -translate-y-1/2',
  right:  'left-full  ml-1 top-1/2  -translate-y-1/2',
};

export function Tooltip({ content, side = 'bottom', children, className }: TooltipProps) {
  const [open, setOpen] = useState(false);
  const id = useId();
  // Wir wrappen das Kind in <span class="relative inline-flex"> damit der
  // Tooltip absolut positioniert werden kann; greifen onMouseEnter/Leave/
  // Focus/Blur ab und merken sie mit ggf. vorhandenen Handlern.
  const child = cloneElement(children, {
    'aria-describedby': open ? id : undefined,
    onMouseEnter: (e: React.MouseEvent) => {
      setOpen(true);
      (children.props.onMouseEnter as ((e: React.MouseEvent) => void) | undefined)?.(e);
    },
    onMouseLeave: (e: React.MouseEvent) => {
      setOpen(false);
      (children.props.onMouseLeave as ((e: React.MouseEvent) => void) | undefined)?.(e);
    },
    onFocus: (e: React.FocusEvent) => {
      setOpen(true);
      (children.props.onFocus as ((e: React.FocusEvent) => void) | undefined)?.(e);
    },
    onBlur: (e: React.FocusEvent) => {
      setOpen(false);
      (children.props.onBlur as ((e: React.FocusEvent) => void) | undefined)?.(e);
    },
  });

  return (
    <span className={twMerge('relative inline-flex', className)}>
      {child}
      {open && (
        <span id={id} role="tooltip" className={twMerge('tooltip', sideCls[side])}>{content}</span>
      )}
    </span>
  );
}
