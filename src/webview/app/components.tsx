import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';

/** A codicon. Decorative: the meaning must always be carried by text or an accessible name. */
export function Icon({ name, spin = false }: { name: string; spin?: boolean }) {
  return (
    <span
      className={`codicon codicon-${name}${spin ? ' codicon-modifier-spin' : ''}`}
      aria-hidden="true"
    />
  );
}

/** Text for screen readers only. */
export function VisuallyHidden({ children }: { children: ReactNode }) {
  return <span className="visually-hidden">{children}</span>;
}

interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label'> {
  icon: string;
  ref?: Ref<HTMLButtonElement>;
  /** Required: an icon-only button has no other name. Also used as the tooltip. */
  label: string;
}

export function IconButton({ icon, label, className, type = 'button', ...rest }: IconButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      className={`icon-button${className ? ` ${className}` : ''}`}
      aria-label={label}
      title={label}
    >
      <Icon name={icon} />
    </button>
  );
}
