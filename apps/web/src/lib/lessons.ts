export function filterLessons<T extends { pattern: string; text: string }>(items: T[], query: string): T[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return items;
  return items.filter((item) => item.pattern.toLowerCase().includes(needle) || item.text.toLowerCase().includes(needle));
}

export function groupByPattern<T extends { pattern: string }>(items: T[]): { pattern: string; items: T[] }[] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const group = groups.get(item.pattern);
    if (group) group.push(item);
    else groups.set(item.pattern, [item]);
  }
  return [...groups].map(([pattern, items]) => ({ pattern, items })).sort((a, b) => b.items.length - a.items.length || a.pattern.localeCompare(b.pattern));
}
