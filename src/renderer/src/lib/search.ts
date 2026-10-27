import type { Idea } from '@shared/types'

/** Lowercase + strip accents so "acao" matches "Ação". */
export function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
}

/** Every whitespace-separated term must appear in the title or body. */
export function matchesQuery(idea: Pick<Idea, 'title' | 'body'>, query: string): boolean {
  const terms = normalize(query).split(/\s+/).filter(Boolean)
  if (terms.length === 0) return true
  const haystack = normalize(`${idea.title}\n${idea.body}`)
  return terms.every((t) => haystack.includes(t))
}

export function filterIdeas<T extends Pick<Idea, 'title' | 'body'>>(ideas: T[], query: string): T[] {
  return query.trim() ? ideas.filter((i) => matchesQuery(i, query)) : ideas
}
