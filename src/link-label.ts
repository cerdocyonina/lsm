/**
 * Where a link keeps the name clients show. Usually the #fragment; mieru clients ignore it
 * and show the profile= query value instead, so for mierus:// links that is the label.
 * Mirrored in web/src/inventory.tsx (labelOf).
 */

const MIERU = /^mierus?:\/\//;
// Same split as encodeMieruLink: '&' starts a new param only when followed by name=.
const PARAM_SPLIT = /&(?=[A-Za-z][\w-]*=)/;

type Slot =
  | { kind: "profile"; start: number; end: number }
  | { kind: "fragment"; start: number; end: number }
  | null;

function decode(value: string, form: boolean): string {
  const raw = form ? value.replace(/\+/g, " ") : value;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** Character range of the label value inside the link, if it has one. */
function slotOf(link: string): Slot {
  const hash = link.indexOf("#");
  if (MIERU.test(link)) {
    const q = link.indexOf("?");
    const end = hash === -1 ? link.length : hash;
    if (q !== -1 && q < end) {
      let offset = q + 1;
      for (const param of link.slice(q + 1, end).split(PARAM_SPLIT)) {
        if (param.startsWith("profile="))
          return { kind: "profile", start: offset + 8, end: offset + param.length };
        offset += param.length + 1;
      }
    }
  }
  return hash === -1 ? null : { kind: "fragment", start: hash + 1, end: link.length };
}

/** Decoded label, or null when the link has none. */
export function labelOf(link: string): string | null {
  const slot = slotOf(link);
  if (!slot) return null;
  return decode(link.slice(slot.start, slot.end), slot.kind === "profile");
}

/** The link with its label replaced (a #label is appended when there is no slot). */
export function withLabel(link: string, label: string): string {
  const slot = slotOf(link);
  const encoded = encodeURIComponent(label);
  if (!slot) return `${link}#${encoded}`;
  return link.slice(0, slot.start) + encoded + link.slice(slot.end);
}

/** The link with the label emptied: equal for links that differ only by label. */
export function withoutLabel(link: string): string {
  const slot = slotOf(link);
  return slot ? link.slice(0, slot.start) + link.slice(slot.end) : link;
}
