// The sign-up side photo (frame NS3, 2x of 614 x 640 is 1228 x 1280), imported so the build hashes the file name (see _home/photos.ts).
import signup from "./photos/signup-side.webp";

// Next gives an image's { src }, Vitest its path.
export const SIGNUP_PHOTO = {
  src: typeof signup === "string" ? signup : (signup as { src: string }).src,
  width: 1228,
  height: 1280,
  alt: "Five friends sitting on a seafront wall with their arms around each other, seen from behind, looking out over the water at a cable car.",
};
