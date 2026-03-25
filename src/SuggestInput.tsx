import { useState, useRef, useEffect, useMemo } from "react";

const MAX_HISTORY = 20;

function getHistory(key: string): string[] {
  try {
    const raw = localStorage.getItem(`smelter:history:${key}`);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveToHistory(key: string, value: string) {
  if (!value.trim()) return;
  const history = getHistory(key);
  const filtered = history.filter((v) => v !== value);
  filtered.unshift(value);
  localStorage.setItem(`smelter:history:${key}`, JSON.stringify(filtered.slice(0, MAX_HISTORY)));
}

export { saveToHistory };

export default function SuggestInput({
  historyKey,
  value,
  onChange,
  placeholder,
  label,
}: {
  historyKey: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const suggestions = useMemo(() => {
    if (!open) return [];
    const history = getHistory(historyKey);
    const q = value.toLowerCase();
    return q
      ? history.filter((h) => h.toLowerCase().includes(q) && h !== value)
      : history.filter((h) => h !== value);
  }, [open, historyKey, value]);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  return (
    <div ref={containerRef} style={{ flex: 1, minWidth: 200, position: "relative" }}>
      <label style={{ display: "block", marginBottom: 4, fontSize: "0.85rem", color: "var(--text-muted)" }}>
        {label}
      </label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setOpen(true)}
        placeholder={placeholder}
        style={{ width: "100%", padding: "0.5rem", fontSize: "1rem", boxSizing: "border-box" }}
      />
      {open && suggestions.length > 0 && (
        <ul
          style={{
            position: "absolute",
            top: "100%",
            left: 0,
            right: 0,
            margin: 0,
            padding: 0,
            listStyle: "none",
            background: "var(--dropdown-bg)",
            border: "1px solid var(--border)",
            borderRadius: 4,
            boxShadow: "0 4px 12px var(--shadow)",
            zIndex: 10,
            maxHeight: 200,
            overflowY: "auto",
          }}
        >
          {suggestions.map((s) => (
            <li
              key={s}
              onMouseDown={() => {
                onChange(s);
                setOpen(false);
              }}
              style={{
                padding: "0.5rem 0.75rem",
                cursor: "pointer",
                fontSize: "0.9rem",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "var(--dropdown-hover)")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            >
              {s}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
