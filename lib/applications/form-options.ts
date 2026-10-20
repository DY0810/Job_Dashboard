import { postingUrl } from './posting-url.ts';

const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (text: string) => text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
  if (name[0] !== '#') return entities[name.toLowerCase()] ?? whole;
  const hex = name[1] === 'x' || name[1] === 'X';
  return String.fromCodePoint(Number.parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10));
});
const norm = (text: string) => decode(text.replace(/<[^>]*>/g, ' ')).replace(/✱/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

/** The choices of the dropdown on a Lever apply page whose label is the question's wording, from the card templates the page embeds. */
export function leverSelectOptions(html: string, wording: string): string[] {
  const label = norm(wording.split('\n\n')[0]);
  if (!label) return [];
  for (const [input] of html.matchAll(/<input\b[^>]*\[baseTemplate\][^>]*>/g)) {
    let card: { fields?: { type?: string; text?: string; options?: { text?: string }[] }[] };
    try { card = JSON.parse(decode(/\bvalue="([^"]*)"/.exec(input)?.[1] ?? '')); } catch { continue; }
    const field = card.fields?.find((item) => item.type === 'dropdown' && norm(item.text ?? '') === label);
    if (field) return (field.options ?? []).map((option) => option.text?.trim() ?? '').filter(Boolean);
  }
  return [];
}

// ponytail: Lever only, where long dropdowns (Palantir's 3,302 universities) are static HTML; add other ATSes when one needs it.
/** A dropdown too long to send with its question is asked as text; the answer box looks its choices up on the form itself. */
export async function formOptions(ats: string, tenant: string, requisition: string, wording: string): Promise<string[]> {
  const url = ats === 'lever' ? postingUrl(ats, tenant, requisition) : null;
  if (!url) return [];
  try {
    const response = await fetch(`${url}/apply`, { redirect: 'error', signal: AbortSignal.timeout(10_000), next: { revalidate: 3600 } });
    return response.ok ? leverSelectOptions(await response.text(), wording).slice(0, 5000) : [];
  } catch {
    return [];
  }
}
