import { logoUpload } from "../../../../../lib/files";

// The company logo (P3): PUT (multipart, field `file`, PNG, JPEG or WebP, at most 1 MB) uploads or replaces it; the account owner only.
export const PUT = (request: Request) => logoUpload(request);
