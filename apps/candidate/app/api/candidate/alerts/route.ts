import { alertsDelete, alertsGet, alertsPost, alertsPut } from "../../../../lib/alerts";

// Job alerts: GET the list, POST creates, PUT { id, ...filters } edits, DELETE { id } removes. Filters only, no free text.
export const GET = alertsGet;
export const POST = alertsPost;
export const PUT = alertsPut;
export const DELETE = alertsDelete;
