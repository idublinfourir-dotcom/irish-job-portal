import { cvRead, cvRemove, cvUpload } from "../../../../lib/files";

// The signed-in candidate's CV: GET its details, PUT (multipart, field `file`, PDF or DOCX) uploads or replaces it, DELETE removes it.
export const GET = cvRead;
export const PUT = cvUpload;
export const DELETE = cvRemove;
