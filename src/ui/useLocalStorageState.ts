import { useState, useCallback } from "react";

/**
 * JSON state that persists to localStorage. Storage failures (private mode, quota) are ignored,
 * so the state still works for the current page.
 */
export function useLocalStorageState<T>(
  key: string,
  load: (stored: unknown) => T,
): [T, (update: (prev: T) => T) => void] {
  const storageKey = `smelter:${key}`;

  const [value, setValueRaw] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      return load(raw === null ? undefined : JSON.parse(raw));
    } catch {
      return load(undefined);
    }
  });

  const setValue = useCallback(
    (update: (prev: T) => T) => {
      setValueRaw((prev) => {
        const next = update(prev);
        try {
          localStorage.setItem(storageKey, JSON.stringify(next));
        } catch {
          // keep in-memory state only
        }
        return next;
      });
    },
    [storageKey],
  );

  return [value, setValue];
}
