interface IconProps {
  name: string;
  filled?: boolean;
  className?: string;
}

export function Icon({ name, filled, className = '' }: IconProps) {
  return (
    <span
      className={`material-symbols-outlined ${filled ? 'fill' : ''} ${className}`}
      style={filled ? { fontVariationSettings: "'FILL' 1" } : undefined}
    >
      {name}
    </span>
  );
}
