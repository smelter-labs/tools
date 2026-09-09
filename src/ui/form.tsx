// Form primitives shared by the tool pages. Every tool lays out its options as rows of
// fieldsets (`OptionGroup`) holding labelled selects, text fields and checkboxes, so the
// styling lives here once and the tools only differ in what they put inside.
import type { CSSProperties, ReactNode } from "react";

export const groupRowStyle: CSSProperties = {
  display: "flex",
  gap: "1rem",
  flexWrap: "wrap",
  alignItems: "flex-start",
  marginBottom: "1rem",
  flexShrink: 0,
};

export const fieldStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  flex: 1,
  minWidth: 180,
};

export const labelStyle: CSSProperties = {
  marginBottom: 4,
  fontSize: "0.85rem",
  color: "var(--text-muted)",
};

export const inputStyle: CSSProperties = {
  width: "100%",
  padding: "0.5rem",
  fontSize: "1rem",
  boxSizing: "border-box",
};

export const buttonStyle: CSSProperties = {
  padding: "0.5rem 1rem",
  fontSize: "0.9rem",
  cursor: "pointer",
};

/** Turns a `{ key: { label } }` table into `<Select>` options keyed by the table's keys. */
export function selectOptions<T extends { label: string }>(
  rec: Record<string, T>,
): { value: string; label: string }[] {
  return Object.entries(rec).map(([value, { label }]) => ({ value, label }));
}

/** Parses a numeric text field; empty or invalid means "leave the default". */
export function optionalNumber(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : undefined;
}

export function OptionGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <fieldset
      style={{
        flex: 1,
        minWidth: 280,
        border: "1px solid var(--border, #444)",
        borderRadius: 6,
        padding: "0.5rem 1rem 1rem",
        margin: 0,
        display: "flex",
        flexWrap: "wrap",
        gap: "1rem",
        alignItems: "flex-start",
      }}
    >
      <legend style={{ padding: "0 0.5rem", fontSize: "0.85rem", color: "var(--text-muted)" }}>
        {label}
      </legend>
      {children}
    </fieldset>
  );
}

export function Select<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <div style={fieldStyle}>
      <label style={labelStyle}>{label}</label>
      <select
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as T)}
        style={inputStyle}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Free-form numeric input; use `optionalNumber` to read it. */
export function NumberField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <div style={fieldStyle}>
      <label style={labelStyle}>{label}</label>
      <input
        type="text"
        inputMode="decimal"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        style={inputStyle}
      />
    </div>
  );
}

export function Checkbox({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label
      style={{
        display: "flex",
        alignItems: "center",
        gap: "0.5rem",
        fontSize: "0.9rem",
        cursor: disabled ? "default" : "pointer",
        // Sit on the baseline of the neighbouring inputs rather than their labels.
        alignSelf: "flex-end",
        paddingBottom: "0.5rem",
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        disabled={disabled}
      />
      {label}
    </label>
  );
}
