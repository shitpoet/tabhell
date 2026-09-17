# tabhell

Control Chrome from the command line: list and open tabs, read bookmarks, grab a
page's HTML or favicon, and run JavaScript inside a page. It is a Chrome
extension plus a native host, so any AI agent that can run a shell command can
work with your browser.

## Installation

    git clone https://github.com/shitpoet/tabhell
    cd tabhell
    npm install ws
    ./tabhell install-host ~/.config/google-chrome

Then open `chrome://extensions`, turn on Developer mode, *Load unpacked*, and
pick the cloned directory. `./tabhell ping` should answer `pong`.

## Commands

```
usage: tabhell <command> [positional ...] [--flag] [--flag=value]

  getTabs                                     list open tabs
  getTabStatus <tabId|host>                   lifecycle state of a tab: discarded, frozen, load status, audio
  getBookmarks                                list bookmarks
  addTab <url> <foreground> <nearTabId>       open a url, optionally right after another tab
  openTab <tabId|host>                        focus a tab and raise its window, by host takes the leftmost
  closeTab <tabId|host>                       close a tab, by host takes the most recently opened
  closeSiteTabs <host>                        close every tab on a host
  getFavicon <tabId|host> <format>            favicon as data url (default), base64 or binary
  getHtml <tabId|host>                        outer html of a tab
  scrollDown <tabId|host> <by>                scroll down, defaults to 80px
  refresh <tabId|host>                        reload a tab, waits for load
  execute <tabId|host> <code>                 run js in the page (MAIN world), an expression or a body with return
  reload                                      reload the extension itself
  ping                                        check the extension is alive

  install-host <browser-directory>            register the native host
      e.g. tabhell install-host ~/.config/google-chrome
  uninstall-host <browser-directory>          remove the native host
```

The CLI is a thin client over the host's own HTTP and WebSocket interfaces on
the same port, so anything can drive it. Every command is a GET whose query
string carries the parameters, and the reply is `{ok, result}` as JSON:

    $ curl '127.0.0.1:29800/execute?host=example.com&code=document.title'
    {"ok":true,"result":"Example Domain"}

Over WebSocket, send `{"id": "1", "action": "getTabs", "params": {}}` and the
reply comes back as `{"id": "1", "ok": true, "result": [...]}`.

## Notes

- The host listens by default on `127.0.0.1:29800` + the display number from
  `$DISPLAY`, so a second X session talks to its own browser
   That is an X11 notion; set `TABHELL_PORT` to pin the port
- `openTab` also focuses the tab's window, so it can raise a window in your face.
- `execute` runs in the page's MAIN world: your code shares the page's globals
  and its CSP, so a strict site can block `eval`, and code you inject can be seen
  by the page. It is an expression (`document.title`) or a function body with
  `return`; either way it runs exactly once, even if it throws
- Supports working with `tabId`s for precise tab managment
- `getFavicon` caches nothing itself, it uses Chrome's own favicon cache
- `reload` restarts the extension, which takes the native host down with it;
  Chrome starts a new one on the next command
- Large replies (a big `getHtml`) are chunked to get past the 1 MB native
  messaging limit; so everything works out of the box
