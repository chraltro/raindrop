/** Where the published hydrology data lives (see pipeline/ for how it is made). */
const base = import.meta.env.BASE_URL.replace(/\/$/, '')
export const DATA_URL = `${base}/data`
export const APP_NAME = 'European River Runner'
export const REPO_URL = 'https://github.com/chraltro/raindrop'
