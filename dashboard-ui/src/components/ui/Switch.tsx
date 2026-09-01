interface SwitchProps {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: string;
  disabled?: boolean;
  ariaLabel?: string;
}

export function Switch({ checked, onChange, label, disabled, ariaLabel }: SwitchProps) {
  const accessibleName = ariaLabel ?? label;

  return (
    <label className={`inline-flex min-h-11 md:min-h-0 items-center gap-3 ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={accessibleName}
        aria-disabled={disabled || undefined}
        disabled={disabled}
        onClick={() => !disabled && onChange(!checked)}
        className="switch-premium focus-ring relative inline-flex h-6 w-11 items-center rounded-full disabled:cursor-not-allowed"
      >
        <span
          aria-hidden="true"
          className={`switch-premium-thumb inline-block h-4 w-4 transform rounded-full bg-white ${
            checked ? 'translate-x-6' : 'translate-x-1'
          }`}
        />
      </button>
      {label && <span className="text-sm text-white/90">{label}</span>}
    </label>
  );
}
