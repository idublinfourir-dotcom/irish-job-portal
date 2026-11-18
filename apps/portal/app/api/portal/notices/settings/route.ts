import { settingsGet, settingsPut } from "../../../../../lib/notices";

// The signed-in login's own notice settings (GET) and changing them (PUT { job_expiry_reminder?, account? }).
export const GET = (request: Request) => settingsGet(request);
export const PUT = (request: Request) => settingsPut(request);
