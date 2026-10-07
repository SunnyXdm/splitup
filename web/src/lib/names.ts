/**
 * Shared copy helpers for people's names in UI text.
 *
 * - shortName: first name for dense rows ("Darshna" for "Darshna Gupta"),
 *   title-cased when the account name is ALL CAPS ("PRIYA DUGGAL" → "Priya").
 * - displayName: "You" (sentence subject) / "you" (object, mid-sentence) for
 *   the signed-in user, else the full name.
 */

interface Named {
  id: number;
  name: string;
}

export type NameCase = 'subject' | 'object';

/** "PRIYA" → "Priya"; mixed-case names are left alone ("McKenzie"). */
function titleIfShouting(word: string): string {
  const hasLetters = /\p{L}/u.test(word);
  if (!hasLetters || word !== word.toUpperCase() || word.length < 2) return word;
  return word
    .toLowerCase()
    .replace(/(^|[\s'’-])(\p{L})/gu, (_, sep: string, ch: string) => sep + ch.toUpperCase());
}

/** A person's full name, title-cased if it was typed in ALL CAPS. */
export function properName(name: string): string {
  return name.trim().split(/\s+/).map(titleIfShouting).join(' ');
}

/** First name for dense rows; falls back to the whole (trimmed) name. */
export function shortName(user: Pick<Named, 'name'> | string): string {
  const name = (typeof user === 'string' ? user : user.name).trim();
  if (!name) return 'Someone';
  return titleIfShouting(name.split(/\s+/)[0]);
}

/**
 * "You"/"you" for me, else the person's name (full, or first name with
 * `short`). Use `object` mid-sentence: "Priya paid you", "You paid Priya".
 */
export function displayName(
  user: Named | undefined,
  meId: number,
  { case: nameCase = 'subject', short = false }: { case?: NameCase; short?: boolean } = {},
): string {
  if (!user) return nameCase === 'subject' ? 'Someone' : 'someone';
  if (user.id === meId) return nameCase === 'subject' ? 'You' : 'you';
  return short ? shortName(user) : user.name;
}

/** Straight 'quoted' spans → typographic ‘quoted’ (apostrophes untouched). */
export function curlyQuotes(text: string): string {
  return text.replace(/(^|[\s(])'([^']+)'(?=$|[\s.,;:!?)])/g, '$1‘$2’');
}

/**
 * Server activity summaries are written in the third person with the actor's
 * name ("Sunny added 'Swiggy' in Flat 4B"). For my own rows say "You", and
 * "you" where I'm the object ("Priya settled up with you").
 */
export function activitySummary(summary: string, me: Pick<Named, 'name'>): string {
  let text = summary;
  const name = me.name.trim();
  if (name) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    text = text
      .replace(new RegExp(`^${escaped}(?=\\s)`), 'You')
      .replace(new RegExp(`(\\b(?:with|to|paid)\\s)${escaped}(?=$|[\\s.,;:!?)])`, 'g'), '$1you');
  }
  return curlyQuotes(text);
}
