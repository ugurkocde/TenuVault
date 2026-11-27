import type { Mapping } from "./api"

const pairs = new Map<string, Mapping[]>()
const key = (source: string, target: string) => `${source.toLowerCase()}:${target.toLowerCase()}`

export function sessionMappings(source: string, target: string): Mapping[] {
  return pairs.get(key(source, target)) ?? []
}

export function rememberMappings(source: string, target: string, mappings: Mapping[]) {
  pairs.set(key(source, target), mappings.filter((mapping) => mapping.confirmed))
}
