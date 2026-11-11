/**
 * Client runtime for `liveRefresh()` elements. One EventSource per topic on
 * the page; each `changed` event re-fetches the elements watching that topic
 * (coalesced, so a burst of build log lines costs one request). Streams close
 * when their elements leave the page, such as when a finished build swaps in
 * a card without `data-live`.
 *
 * If the stream cannot be opened at all (no EventSource, or the server
 * refused it), the elements fall back to a slow poll.
 */
export const LIVE_PATH = '/console/live'

export const LIVE_SCRIPT = `
(() => {
  if (window.__bunwriteLive) return
  window.__bunwriteLive = true
  const FALLBACK_MS = 15000
  const streams = new Map()
  const watching = (topic) => [...document.querySelectorAll("[data-live]")].filter((el) => el.dataset.live === topic)
  function refresh(topic) {
    const stream = streams.get(topic)
    if (!stream || stream.pending) return
    stream.pending = setTimeout(() => {
      stream.pending = 0
      if (!window.htmx) return
      for (const el of watching(topic)) window.htmx.trigger(el, "live")
    }, 150)
  }
  function fallback(stream, topic) {
    if (stream.timer) return
    stream.timer = setInterval(() => refresh(topic), FALLBACK_MS)
  }
  function open(topic) {
    const stream = { source: null, timer: 0, pending: 0, opened: false }
    streams.set(topic, stream)
    if (!window.EventSource) return fallback(stream, topic)
    const source = new EventSource("${LIVE_PATH}?topic=" + encodeURIComponent(topic))
    stream.source = source
    source.addEventListener("changed", () => refresh(topic))
    source.addEventListener("open", () => {
      // After a reconnect, changes made while disconnected were missed. On the
      // first open, a card showing a running build may already be stale.
      if (stream.opened || watching(topic).some((el) => el.hasAttribute("data-live-busy"))) refresh(topic)
      stream.opened = true
    })
    source.addEventListener("error", () => {
      if (source.readyState === EventSource.CLOSED) fallback(stream, topic)
    })
  }
  function close(topic) {
    const stream = streams.get(topic)
    if (!stream) return
    if (stream.source) stream.source.close()
    clearInterval(stream.timer)
    clearTimeout(stream.pending)
    streams.delete(topic)
  }
  function sync() {
    const wanted = new Set([...document.querySelectorAll("[data-live]")].map((el) => el.dataset.live))
    for (const topic of [...streams.keys()]) if (!wanted.has(topic)) close(topic)
    for (const topic of wanted) if (!streams.has(topic)) open(topic)
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", sync)
  else sync()
  document.addEventListener("htmx:afterSettle", sync)
  addEventListener("pagehide", () => { for (const topic of [...streams.keys()]) close(topic) })
  addEventListener("pageshow", (event) => { if (event.persisted) sync() })
})()
`
