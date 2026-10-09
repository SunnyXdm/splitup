/** Case- and accent-insensitive search over a picker option's texts. */
export function matchesQuery(
  option: { value: string; label: string; sublabel?: string },
  query: string,
): boolean {
  const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  const q = fold(query.trim());
  if (q === '') return true;
  return [option.value, option.label, option.sublabel ?? ''].some((t) => fold(t).includes(q));
}
