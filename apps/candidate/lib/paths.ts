// The one place a public page's path is made. The URL scheme is a placeholder until the page designs (step 16) fix it; change it only here.
export const jobPath = (id: string) => `/jobs/${encodeURIComponent(id)}`;
export const companyPath = (slug: string) => `/companies/${encodeURIComponent(slug)}`;
export const occupationPath = (code: string) => `/occupations/${encodeURIComponent(code)}`;
