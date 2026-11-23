// National permit figures for the home page (frame N01: hero stat, the 27% card, "Where permits go", the sector tiles).
// Source: DETE "Employment permits by sector 2026" (xlsx on the page below), January to October 2026, read on 23 Nov 2026
// (step16/check/r10-closed-items.md rows 171 and 172). The total equals our dete_permit_count 2026 total (33,362).
// ponytail: typed by hand from DETE's monthly file; move to a table with an import job (Later L44, old B22) if monthly edits become a chore.
export const DETE_FIGURES = {
  period: "January to October 2026",
  short: "Jan to Oct 2026",
  total: 33362,
  source: "https://enterprise.gov.ie/en/publications/employment-permit-statistics-2026.html",
  /** Share of all permits, in DETE's order, for the five biggest sectors we list jobs in, plus pharma. Our sector key beside each. */
  sectors: [
    { label: "Health and social work", short: "Health", share: 26.7, sector: "health" },
    { label: "Accommodation and food", short: "Hospitality", share: 10.3, sector: "hospitality" },
    { label: "Information and communication", short: "IT", share: 9.7, sector: "IT" },
    { label: "Construction", short: "Construction", share: 6.9, sector: "construction and engineering" },
    { label: "Financial and insurance", short: "Finance", share: 4.0, sector: "finance" },
    { label: "Chemicals and pharmaceuticals", short: "Pharma", share: 1.4, sector: "pharma and science" },
  ],
} as const;

const TOP5 = DETE_FIGURES.sectors.slice(0, 5);
/** "27%": whole percent, as the frame prints them. */
export const pct = (n: number) => `${Math.round(n)}%`;
export const topFiveShare = TOP5.reduce((s, x) => s + x.share, 0);
export const NUM = new Intl.NumberFormat("en-IE");
