import { useState, useCallback } from "react";

/**
 * Input state that persists to sessionStorage.
 * Priority: sessionStorage > query param > fallback.
 */
export function useSessionInput(
  key: string,
  params: URLSearchParams,
  paramName: string,
  fallback: string = "",
): [string, (value: string) => void] {
  const storageKey = `smelter:${key}`;

  const [value, setValueRaw] = useState(() => {
    const stored = sessionStorage.getItem(storageKey);
    if (stored !== null) return stored;
    return params.get(paramName) ?? fallback;
  });

  const setValue = useCallback(
    (v: string) => {
      sessionStorage.setItem(storageKey, v);
      setValueRaw(v);
    },
    [storageKey],
  );

  return [value, setValue];
}
