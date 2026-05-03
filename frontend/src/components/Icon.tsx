interface IconProps {
  name: string;
  filled?: boolean;
  className?: string;
  /** Provide when the icon stands alone with no nearby text. Otherwise it is decorative. */
  label?: string;
}

export function Icon({ name, filled, className = '', label }: IconProps) {
  return (
    <span
      className={`material-symbols-outlined ${filled ? 'fill' : ''} ${className}`}
      style={filled ? { fontVariationSettings: "'FILL' 1" } : undefined}
      aria-hidden={label ? undefined : true}
      role={label ? 'img' : undefined}
      aria-label={label}
    >
      {name}
    </span>
  );
}
