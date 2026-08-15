/**
 * Minimaler Tooltip auf Hover/Focus.
 *
 * Kein external Lib (Floating-UI etc.). Anders als die fruehere rein relative
 * Positionierung wird der Tooltip viewport-bezogen gemessen und geklemmt.
 * Dadurch koennen Topbar-Tooltips auf schmalen Mobile-Viewports keinen
 * horizontalen Dokument-Overflow mehr erzeugen.
 */
import {
  cloneElement,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from 'react';
import { twMerge } from 'tailwind-merge';

interface TooltipProps {
  content: ReactNode;
  side?: 'top' | 'bottom' | 'left' | 'right';
  /** Einzelnes interaktives Kind, dessen Hover-/Focus-Handler wir verkleben. */
  children: ReactElement;
  className?: string;
}

const GAP_PX = 6;
const VIEWPORT_MARGIN_PX = 8;

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

export function Tooltip({ content, side = 'bottom', children, className }: TooltipProps) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<CSSProperties | null>(null);
  const wrapperRef = useRef<HTMLSpanElement | null>(null);
  const tooltipRef = useRef<HTMLSpanElement | null>(null);
  const id = useId();

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }

    const updatePosition = (): void => {
      const wrapper = wrapperRef.current;
      const tooltip = tooltipRef.current;
      if (!wrapper || !tooltip) return;

      const anchor = wrapper.getBoundingClientRect();
      const tip = tooltip.getBoundingClientRect();
      let left = anchor.left + (anchor.width - tip.width) / 2;
      let top = anchor.bottom + GAP_PX;

      switch (side) {
        case 'top':
          top = anchor.top - tip.height - GAP_PX;
          break;
        case 'left':
          left = anchor.left - tip.width - GAP_PX;
          top = anchor.top + (anchor.height - tip.height) / 2;
          break;
        case 'right':
          left = anchor.right + GAP_PX;
          top = anchor.top + (anchor.height - tip.height) / 2;
          break;
        case 'bottom':
        default:
          break;
      }

      const maxLeft = window.innerWidth - tip.width - VIEWPORT_MARGIN_PX;
      const maxTop = window.innerHeight - tip.height - VIEWPORT_MARGIN_PX;
      setPosition({
        position: 'fixed',
        left: `${Math.round(clamp(left, VIEWPORT_MARGIN_PX, maxLeft))}px`,
        top: `${Math.round(clamp(top, VIEWPORT_MARGIN_PX, maxTop))}px`,
        transform: 'none',
        visibility: 'visible',
      });
    };

    updatePosition();
    window.addEventListener('resize', updatePosition);
    // Capture-Scroll: auch verschachtelte Scroll-Container verschieben den
    // Anchor und muessen den fixed Tooltip neu positionieren.
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open, side, content]);

  const child = cloneElement(children, {
    'aria-describedby': open ? id : undefined,
    onMouseEnter: (event: React.MouseEvent) => {
      setOpen(true);
      (children.props.onMouseEnter as ((event: React.MouseEvent) => void) | undefined)?.(event);
    },
    onMouseLeave: (event: React.MouseEvent) => {
      setOpen(false);
      (children.props.onMouseLeave as ((event: React.MouseEvent) => void) | undefined)?.(event);
    },
    onFocus: (event: React.FocusEvent) => {
      setOpen(true);
      (children.props.onFocus as ((event: React.FocusEvent) => void) | undefined)?.(event);
    },
    onBlur: (event: React.FocusEvent) => {
      setOpen(false);
      (children.props.onBlur as ((event: React.FocusEvent) => void) | undefined)?.(event);
    },
  });

  return (
    <span ref={wrapperRef} className={twMerge('relative inline-flex', className)}>
      {child}
      {open && (
        <span
          ref={tooltipRef}
          id={id}
          role="tooltip"
          className="tooltip"
          style={position ?? {
            position: 'fixed',
            left: 0,
            top: 0,
            transform: 'none',
            visibility: 'hidden',
          }}
        >
          {content}
        </span>
      )}
    </span>
  );
}
