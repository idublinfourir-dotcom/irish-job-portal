// The employer landing hero photo (frame NE1, 2x of 500 x 468 is 1000 x 940), imported so the build hashes the file name (see candidate _home/photos.ts).
import hero from "./photos/employer-hero.webp";

// Next gives an image's { src }, Vitest its path.
const src = (p: string | { src: string }) => (typeof p === "string" ? p : p.src);

export const EMPLOYER_HERO = {
  src: src(hero),
  width: 1000,
  height: 940,
  alt: "Four colleagues around a cafe table, smiling and talking over a tablet and a laptop.",
};
