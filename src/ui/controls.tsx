import { useId, type ReactNode } from "react";

export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string; disabled?: boolean }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="field">
      <span className="field__name">{label}</span>
      <div className="seg" role="radiogroup" aria-label={label}>
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={value === o.value}
            disabled={o.disabled}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  format = (v) => v.toFixed(2),
  help,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  format?: (v: number) => string;
  help?: ReactNode;
}) {
  const id = useId();
  const p = ((value - min) / (max - min)) * 100;
  return (
    <div className="field">
      <div className="field__row">
        <label className="field__name" htmlFor={id}>
          {label}
        </label>
        <span className="field__value">{format(value)}</span>
      </div>
      <input
        id={id}
        className="range"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        style={{ "--p": `${p}%` } as React.CSSProperties}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      {help && <span className="field__help">{help}</span>}
    </div>
  );
}

export function Switch({
  label,
  help,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  help?: ReactNode;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="switch" style={disabled ? { opacity: 0.45, cursor: "default" } : undefined}>
      <span className="switch__text">
        <span className="field__name">{label}</span>
        {help && <span className="field__help">{help}</span>}
      </span>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="switch__track" aria-hidden />
    </label>
  );
}

export function Select<T extends string | number>({
  label,
  value,
  options,
  onChange,
  help,
}: {
  label?: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  help?: ReactNode;
}) {
  const id = useId();
  const select = (
    <select
      id={id}
      className="select"
      value={String(value)}
      aria-label={label}
      onChange={(e) => {
        const raw = e.target.value;
        const match = options.find((o) => String(o.value) === raw);
        if (match) onChange(match.value);
      }}
    >
      {options.map((o) => (
        <option key={String(o.value)} value={String(o.value)}>
          {o.label}
        </option>
      ))}
    </select>
  );
  if (!label) return select;
  return (
    <div className="field">
      <label className="field__name" htmlFor={id}>
        {label}
      </label>
      {select}
      {help && <span className="field__help">{help}</span>}
    </div>
  );
}

export function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="section">
      <h3 className="section__label">{label}</h3>
      {children}
    </section>
  );
}
