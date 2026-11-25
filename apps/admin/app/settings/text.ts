// The words of the settings page, pure so a test covers them.
export const valueText = (value: number | null, unit: string | null): string => (value === null ? "Not set" : unit ? `${value} ${unit}` : String(value));
/** The box's text as the route's value: empty is null (not set), a whole number from 0 to 100,000 is that number, anything else is undefined (refused before it is sent). */
export function readValue(text: string): number | null | undefined {
  const t = text.trim();
  if (t === "") return null;
  return /^\d{1,6}$/.test(t) && Number(t) <= 100000 ? Number(t) : undefined;
}
