// Parameter order doubles as positional-argument order for the CLI.
export const commands = {
  getTabs: { params: {}, help: 'list open tabs' },
  getTabStatus: {
    params: { tabId: 'number', host: 'string' },
    help: 'lifecycle state of a tab: discarded, frozen, load status, audio'
  },
  getBookmarks: { params: {}, help: 'list bookmarks' },
  addTab: {
    params: { url: 'string', foreground: 'boolean', nearTabId: 'number' },
    help: 'open a url, optionally right after another tab'
  },
  openTab: {
    params: { tabId: 'number', host: 'string' },
    help: 'focus a tab and raise its window, by host takes the leftmost'
  },
  closeTab: {
    params: { tabId: 'number', host: 'string' },
    help: 'close a tab, by host takes the most recently opened'
  },
  closeSiteTabs: {
    params: { host: 'string' },
    help: 'close every tab on a host'
  },
  getFavicon: {
    params: { tabId: 'number', host: 'string', format: 'string' },
    help: 'favicon as data url (default), base64 or binary'
  },
  getHtml: {
    params: { tabId: 'number', host: 'string' },
    help: 'outer html of a tab'
  },
  scrollDown: {
    params: { tabId: 'number', host: 'string', by: 'number' },
    help: 'scroll down, defaults to 80px'
  },
  refresh: {
    params: { tabId: 'number', host: 'string' },
    help: 'reload a tab, waits for load'
  },
  execute: {
    params: { tabId: 'number', host: 'string', code: 'string' },
    help: 'run js in the page (MAIN world), an expression or a body with return'
  },
  reload: { params: {}, help: 'reload the extension itself' },
  ping: { params: {}, help: 'check the extension is alive' },
}

const BASE_PORT = 29800

export function resolvePort(env) {
  if (env.TABHELL_PORT) {
    return Number(env.TABHELL_PORT)
  }
  const display = env.DISPLAY || ''
  const colon = display.lastIndexOf(':')
  let offset = 0
  if (colon >= 0) {
    offset = parseInt(display.slice(colon + 1), 10) || 0
  }
  return BASE_PORT + offset
}

export function parseParams(searchParams, schema) {
  const params = {}
  for (const [key, raw] of searchParams) {
    if (schema[key] === 'number') {
      params[key] = Number(raw)
    } else if (schema[key] === 'boolean') {
      params[key] = raw !== 'false' && raw !== '0'
    } else {
      params[key] = raw
    }
  }
  return params
}
