import { logoPublic } from "../../../../../../lib/files";

// The public address of a company's logo (B54): no login, GET only. The file is the stored, re-encoded and scanned logo of the company's current upload.
export const GET = async (_request: Request, { params }: { params: Promise<{ file: string }> }) => logoPublic((await params).file);
