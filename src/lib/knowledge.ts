import type { Knowledge, Snapshot } from '../types';
export function tokens(text: string): string[] {
  const normalized = text.toLowerCase();
  const words: string[] = normalized.match(/[a-z0-9+#.]{2,}|[\u4e00-\u9fa5]/g) || [];
  for (const part of normalized.match(/[\u4e00-\u9fa5]{2,}/g) || [])
    for (let i = 0; i < part.length - 1; i++) words.push(part.slice(i, i + 2));
  return [...new Set(words)];
}
export function retrieveKnowledge(
  entries: Knowledge[],
  snapshot: Snapshot,
  limit = 18,
): Knowledge[] {
  const query = new Set(
    tokens(
      snapshot.fields.map((f) => `${f.label} ${f.section}`).join(' ') +
        ' ' +
        snapshot.context.slice(0, 5000),
    ),
  );
  return entries
    .map((entry, index) => {
      const title = tokens(entry.title + ' ' + entry.keywords.join(' '));
      const body = tokens(entry.content);
      return {
        entry,
        index,
        score:
          title.reduce((s, t) => s + (query.has(t) ? 4 : 0), 0) +
          body.reduce((s, t) => s + (query.has(t) ? 1 : 0), 0),
      };
    })
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map((x) => x.entry);
}
