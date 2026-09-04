import * as bridge from './bridge.js'

const HOST_NAME = 'cc.shitpoet.tabhell'
const RECONNECT_BASE_MS = 500
const RECONNECT_MAX_MS = 10_000
const STABLE_CONNECTION_MS = 2000
const RELOAD_TIMEOUT_MS = 30_000
const FAVICON_SIZE = 32
const SCROLL_STEP_PX = 80

let port = null
let assemble = bridge.makeAssembler()
let reconnectDelay = RECONNECT_BASE_MS
let lastConnectAt = 0

function connect() {
  if (port) {
    return
  }
  lastConnectAt = Date.now()
  assemble = bridge.makeAssembler()
  port = chrome.runtime.connectNative(HOST_NAME)
  port.onMessage.addListener(onEnvelope)
  port.onDisconnect.addListener(onDisconnect)
}

// connectNative resolves even when the host is missing: the failure shows up as
// an immediate disconnect, so only a connection that lasted counts as real.
function onDisconnect() {
  void chrome.runtime.lastError
  port = null
  if (Date.now() - lastConnectAt >= STABLE_CONNECTION_MS) {
    reconnectDelay = RECONNECT_BASE_MS
  }
  setTimeout(connect, reconnectDelay)
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS)
}

function send(msg) {
  if (port) {
    for (const envelope of bridge.fragment(msg)) {
      port.postMessage(envelope)
    }
  }
}

async function onEnvelope(envelope) {
  const msg = assemble(envelope)
  if (msg) {
    const reply = await run(msg.action, msg.params || {})
    send({ id: msg.id, ...reply })
  }
}

async function run(action, params) {
  try {
    const handler = handlers[action]
    if (handler === undefined) {
      throw new Error('unknown action: ' + action)
    }
    return { ok: true, result: await handler(params) }
  } catch (e) {
    return { ok: false, result: String(e) }
  }
}

// Accepts a url or a bare hostname. www is dropped so google.com and
// www.google.com are one host, but spelling www out asks for that host alone:
// naming a subdomain, any subdomain, means subdomains are not wanted.
function hostQuery(value) {
  let host = value
  if (host.includes('://')) {
    host = new URL(host).hostname
  }
  const spelledOut = host.startsWith('www.')
  if (spelledOut) {
    host = host.slice(4)
  }
  return { host, exactOnly: spelledOut }
}

function toHost(value) {
  return hostQuery(value).host
}

// A match pattern would only ever hit the exact host, so subdomains are matched
// here instead. They are kept apart because google.com should mean the site
// itself when such a tab exists, and only fall back to mail.google.com when it
// does not; closeSiteTabs wants both.
function tabsForHost(tabs, value) {
  const { host, exactOnly } = hostQuery(value)
  const exact = []
  const nested = []
  for (const tab of tabs) {
    if (tab.url) {
      const tabHost = toHost(tab.url)
      if (tabHost === host) {
        exact.push(tab)
      } else if (!exactOnly && tabHost.endsWith('.' + host)) {
        nested.push(tab)
      }
    }
  }
  return { exact, nested }
}

// By host, query order is window-then-index, so tabs[0] is the leftmost match.
// `newest` picks the highest tab id instead: Chrome hands them out in creation
// order, so that is the most recently opened one.
async function resolveTab(params, newest) {
  if (params.tabId != null) {
    return await chrome.tabs.get(params.tabId)
  }
  if (params.host) {
    const { exact, nested } = tabsForHost(await chrome.tabs.query({}), params.host)
    const matches = exact.length > 0 ? exact : nested
    if (matches.length > 0) {
      if (newest) {
        return matches.reduce((best, tab) => (tab.id > best.id ? tab : best))
      }
      return matches[0]
    }
    throw new Error('no tab for host ' + toHost(params.host))
  }
  throw new Error('tabId or host is required')
}

// Every arg has to be structured-cloneable: an undefined left by a missing
// param makes executeScript throw before the injection ever happens.
async function inject(params, world, func, args) {
  const tab = await resolveTab(params)
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world,
    func,
    args
  })
  return result
}

function bytesToBase64(bytes) {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192))
  }
  return btoa(binary)
}

function flattenBookmarks(nodes, out) {
  for (const node of nodes) {
    if (node.url && !node.url.startsWith('javascript:')) {
      out.push({ id: node.id, title: node.title, url: node.url })
    }
    if (node.children) {
      flattenBookmarks(node.children, out)
    }
  }
  return out
}

// Runs in the page. `code` is an expression, so `document.title` works on its
// own, or a function body, which is what anything with statements or an
// explicit `return` parses as. Which one it is is decided by parsing it, never
// by running it and retrying on failure: a retry would repeat side effects like
// a click when the code itself throws a SyntaxError (JSON.parse). `new Function`
// parses without running, and the indirect eval keeps our locals out of scope.
// The newline stops a trailing `//` comment from eating the wrapper's tail.
// Failures are caught here because a throw inside MAIN would reach us stripped
// of its message.
async function evalInPage(code) {
  const expression = '(async () => (' + code + '\n))()'
  const body = '(async () => {' + code + '\n})()'
  let wrapper = body
  try {
    new Function(expression)
    wrapper = expression
  } catch (e) {
    // not an expression
  }
  try {
    const value = await (0, eval)(wrapper)
    return { ok: true, result: value === undefined ? null : value }
  } catch (e) {
    return { ok: false, result: String(e) }
  }
}

const handlers = {
  getTabs: async () => {
    const tabs = await chrome.tabs.query({})
    return tabs.map((tab) => ({
      id: tab.id,
      title: tab.title,
      url: tab.url,
      active: tab.active,
      windowId: tab.windowId,
      lastAccessed: tab.lastAccessed
    }))
  },

  getBookmarks: async () => {
    return flattenBookmarks(await chrome.bookmarks.getTree(), [])
  },

  addTab: async (params) => {
    const options = { url: params.url, active: params.foreground === true }
    if (params.nearTabId != null) {
      const near = await chrome.tabs.get(params.nearTabId)
      options.windowId = near.windowId
      options.index = near.index + 1
      options.openerTabId = near.id
    }
    const tab = await chrome.tabs.create(options)
    return { tabId: tab.id }
  },

  openTab: async (params) => {
    const tab = await resolveTab(params)
    await chrome.tabs.update(tab.id, { active: true })
    await chrome.windows.update(tab.windowId, { focused: true })
    return { tabId: tab.id }
  },

  closeTab: async (params) => {
    const tab = await resolveTab(params, true)
    await chrome.tabs.remove(tab.id)
    return { tabId: tab.id }
  },

  closeSiteTabs: async (params) => {
    const { exact, nested } = tabsForHost(await chrome.tabs.query({}), params.host)
    const tabs = exact.concat(nested)
    if (tabs.length > 0) {
      await chrome.tabs.remove(tabs.map((tab) => tab.id))
    }
    return { closed: tabs.length }
  },

  getFavicon: async (params) => {
    let pageUrl = ''
    if (params.tabId != null) {
      pageUrl = (await chrome.tabs.get(params.tabId)).url
    } else {
      pageUrl = 'https://' + toHost(params.host) + '/'
    }
    const url = chrome.runtime.getURL('/_favicon/') +
      '?pageUrl=' + encodeURIComponent(pageUrl) + '&size=' + FAVICON_SIZE
    const response = await fetch(url)
    const base64 = bytesToBase64(new Uint8Array(await response.arrayBuffer()))
    if (params.format === 'data' || params.format === undefined) {
      return 'data:image/png;base64,' + base64
    }
    return base64
  },

  getHtml: async (params) => {
    return await inject(params, 'ISOLATED', () => document.documentElement.outerHTML, [])
  },

  scrollDown: async (params) => {
    return await inject(params, 'ISOLATED', (by) => {
      window.scrollBy(0, by)
      return window.scrollY
    }, [params.by ?? SCROLL_STEP_PX])
  },

  refresh: async (params) => {
    const tab = await resolveTab(params)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener)
        reject(new Error('reload timed out'))
      }, RELOAD_TIMEOUT_MS)

      function listener(tabId, info) {
        if (tabId === tab.id && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener)
          clearTimeout(timer)
          resolve()
        }
      }
      chrome.tabs.onUpdated.addListener(listener)
      chrome.tabs.reload(tab.id)
    })
    return { tabId: tab.id }
  },

  execute: async (params) => {
    const outcome = await inject(params, 'MAIN', evalInPage, [params.code ?? ''])
    if (outcome.ok) {
      return outcome.result
    }
    throw new Error(outcome.result)
  },

  // The reply has to go out before the port dies with us. The host follows us
  // down and Chrome respawns it once we reconnect.
  reload: async () => {
    setTimeout(() => chrome.runtime.reload(), 100)
    return 'reloading'
  },

  ping: async () => 'pong'
}

chrome.runtime.onInstalled.addListener(connect)
chrome.runtime.onStartup.addListener(connect)

chrome.alarms.create('keepAlive', { periodInMinutes: 0.5 })
chrome.alarms.onAlarm.addListener(connect)

connect()
