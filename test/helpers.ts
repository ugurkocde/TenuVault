export function memoryStore() {
  const values = new Map<string, string>()
  return {
    get: (key: string) => values.get(key) ?? null,
    set: (key: string, value: string) => void values.set(key, value),
    delete: (key: string) => void values.delete(key),
    keys: () => [...values.keys()],
    values,
  }
}
