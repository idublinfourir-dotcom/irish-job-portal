// The home page's photos, imported one by one: the build puts a content hash in each file name and serves it cached for a year (public/ files are
// sent max-age=0). Not import.meta.glob: Next 16.4.5's production build reads its result wrongly, so every photo was missing (24 Nov 2026).
import employer from "./photos/employer.webp";
import face1 from "./photos/face-1.webp";
import face10 from "./photos/face-10.webp";
import face2 from "./photos/face-2.webp";
import face3 from "./photos/face-3.webp";
import face4 from "./photos/face-4.webp";
import face5 from "./photos/face-5.webp";
import face6 from "./photos/face-6.webp";
import face7 from "./photos/face-7.webp";
import face8 from "./photos/face-8.webp";
import face9 from "./photos/face-9.webp";
import family from "./photos/family.webp";
import guide1 from "./photos/guide-1.webp";
import guide2 from "./photos/guide-2.webp";
import guide3 from "./photos/guide-3.webp";
import hero from "./photos/hero.webp";
import occCarers from "./photos/occ-carers.webp";
import occChefs from "./photos/occ-chefs.webp";
import occDoctors from "./photos/occ-doctors.webp";
import occEngineers from "./photos/occ-engineers.webp";
import occNurses from "./photos/occ-nurses.webp";
import occPharmacists from "./photos/occ-pharmacists.webp";
import occSoftware from "./photos/occ-software.webp";
import rulesCard from "./photos/rules-card.webp";
import sectorConstruction from "./photos/sector-construction.webp";
import sectorFinance from "./photos/sector-finance.webp";
import sectorHealth from "./photos/sector-health.webp";
import sectorHospitality from "./photos/sector-hospitality.webp";
import sectorIt from "./photos/sector-it.webp";
import sectorPharma from "./photos/sector-pharma.webp";

// Next gives an image's { src }, Vitest its path.
const PHOTOS = new Map<string, string | { src: string }>([
  ["employer", employer],
  ["face-1", face1],
  ["face-10", face10],
  ["face-2", face2],
  ["face-3", face3],
  ["face-4", face4],
  ["face-5", face5],
  ["face-6", face6],
  ["face-7", face7],
  ["face-8", face8],
  ["face-9", face9],
  ["family", family],
  ["guide-1", guide1],
  ["guide-2", guide2],
  ["guide-3", guide3],
  ["hero", hero],
  ["occ-carers", occCarers],
  ["occ-chefs", occChefs],
  ["occ-doctors", occDoctors],
  ["occ-engineers", occEngineers],
  ["occ-nurses", occNurses],
  ["occ-pharmacists", occPharmacists],
  ["occ-software", occSoftware],
  ["rules-card", rulesCard],
  ["sector-construction", sectorConstruction],
  ["sector-finance", sectorFinance],
  ["sector-health", sectorHealth],
  ["sector-hospitality", sectorHospitality],
  ["sector-it", sectorIt],
  ["sector-pharma", sectorPharma],
]);

export function photoSrc(name: string): string {
  const photo = PHOTOS.get(name);
  if (!photo) throw new Error(`no photo ${name} in _home/photos`);
  return typeof photo === "string" ? photo : photo.src;
}
