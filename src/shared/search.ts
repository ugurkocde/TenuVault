/** Lowercased words of a search box; empty when the box is blank. */
export function searchTerms(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean)
}

/** Whether every term appears in the lowercased text. No terms match everything. */
export function matchesTerms(text: string, terms: string[]): boolean {
  return terms.every(term => text.includes(term))
}
