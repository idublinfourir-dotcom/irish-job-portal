import { settingsGet, settingsPut } from "../../../../lib/account";

// Notification settings: GET, PUT { job_alerts?, apply_reminders?, account? } (account cannot be switched off).
export const GET = settingsGet;
export const PUT = settingsPut;
