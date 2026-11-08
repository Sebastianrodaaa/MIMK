// Vendored copy of @mimk/shared's filterSensitive (same regexes) so the
// package stays dependency-free inside the agent container.
const PHONE = /(\+\d[\d\s().-]{7,}\d|\d[\d\s().-]{9,}\d)/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const STREET =
  /\b\d{1,6}\s+[A-Za-z0-9.\s]{2,40}\s(street|st\.?|avenue|ave\.?|road|rd\.?|lane|ln\.?|drive|dr\.?|boulevard|blvd\.?|way|court|ct\.?|place|pl\.?|parkway|pkwy\.?|terrace|ter\.?)\b/gi;

export function filterSensitive(text: string): string {
  return text
    .replace(EMAIL, "[redacted-email]")
    // >=10 digits, or + followed by >=8 digits; year ranges/dates have too few digits
    .replace(PHONE, (m) => {
      const digits = (m.match(/\d/g) ?? []).length;
      return digits >= 10 || (m.trimStart().startsWith("+") && digits >= 8) ? "[redacted-phone]" : m;
    })
    .replace(STREET, "[redacted-address]");
}
