import { useState } from 'react';
import { CircleAlert } from 'lucide-react';
import { Modal } from './Modal';
import { Tooltip } from './Tooltip';

interface FunctionHelpButtonProps {
  title: string;
  text: string[];
}

export function FunctionHelpButton({ title, text }: FunctionHelpButtonProps) {
  const [open, setOpen] = useState(false);

  return <>
    <Tooltip content={`Hilfe zu ${title}`}>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border text-muted hover:border-accent/60 hover:text-accent focus-ring"
        aria-label={`Hilfe zu ${title}`}
      >
        <CircleAlert className="h-4 w-4" aria-hidden="true" />
      </button>
    </Tooltip>
    <Modal open={open} onClose={() => setOpen(false)} title={title} desc="Kurz erklärt">
      {text.map(paragraph => <p key={paragraph} className="text-sm leading-6 text-white/85">{paragraph}</p>)}
    </Modal>
  </>;
}