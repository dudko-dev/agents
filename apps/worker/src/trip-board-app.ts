/**
 * The trip board's document: the MCP App `ui://demo/trip-board.html` (see `trip-board.ts`). One
 * file - markup, styles and one script, all inline - that reaches no origin: its resource
 * declares empty CSP lists, and a host enforces them.
 *
 * The script speaks the extension's JSON-RPC over `postMessage` by hand, as the specification
 * (2026-01-26) describes it, with no SDK: `ui/initialize` (its `appInfo`, `appCapabilities`,
 * `protocolVersion`), then `ui/notifications/initialized`, then the host's
 * `ui/notifications/tool-input` and `tool-result` (or `tool-cancelled`); it answers `ping` and
 * `ui/resource-teardown`, follows `ui/notifications/host-context-changed` (the theme), and reports
 * its height (`ui/notifications/size-changed`, as the extension's SDK measures it). What the user
 * does becomes the app's requests - `tools/call` (`reshuffle_day`, `book_trip`), `ui/open-link`,
 * `ui/message`, and where the host offers them `ui/request-display-mode` (Full screen, Esc back),
 * `ui/download-file` (the itinerary as a `.txt`, `hostCapabilities.downloadFile`) and
 * `sampling/createMessage` (a dinner idea from the HOST's model, `hostCapabilities.sampling`) -
 * each of which the host may put to the user first.
 *
 * Everything the server sends is rendered with `textContent`; the only markup set from script is
 * the constant icons below. No backticks and no backslashes in the script: it lives in a template
 * literal (`tests/demo-server.test.ts` compiles it).
 */

/** A value as a script literal that cannot close the `<script>` it is in. */
const literal = (value: unknown): string => JSON.stringify(value).replace(/</g, '\\u003c')

const STYLE = `
*,*::before,*::after{box-sizing:border-box}
:root{color-scheme:light;--bg:#f6f4ef;--card:#fff;--sunk:#efebe3;--line:#e2ddd2;--line-2:#cdc6b8;--text:#1c1a17;--muted:#57524a;--faint:#6b665e;--accent:#035ca8;--accent-2:#024a88;--on-accent:#fff;--accent-soft:rgb(3 92 168/.09);--ok:#13703a;--ok-soft:rgb(19 112 58/.08);--bad:#b42318;--wait:#8a5a00;--focus:#035ca8;--shadow:0 1px 2px rgb(28 22 10/.06),0 6px 18px -12px rgb(28 22 10/.25);--walk:#0369a1;--food:#b45309;--culture:#7c3aed;--nature:#15803d;--view:#be185d;--night:#4338ca;--travel:#57534e;--sight:#c2410c}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){color-scheme:dark;--bg:#0b111c;--card:#111a29;--sunk:#0d1522;--line:#1f2a3e;--line-2:#2d3b57;--text:#e8ecf3;--muted:#a6b1c2;--faint:#8b97ab;--accent:#2f9fe0;--accent-2:#5bb7ee;--on-accent:#04121f;--accent-soft:rgb(47 159 224/.13);--ok:#4ade80;--ok-soft:rgb(74 222 128/.09);--bad:#f87171;--wait:#fbbf24;--focus:#8fd0f7;--shadow:0 1px 0 rgb(0 0 0/.35);--walk:#38bdf8;--food:#f59e0b;--culture:#a78bfa;--nature:#4ade80;--view:#f472b6;--night:#a5b4fc;--travel:#94a3b8;--sight:#fb923c}}
:root[data-theme=dark]{color-scheme:dark;--bg:#0b111c;--card:#111a29;--sunk:#0d1522;--line:#1f2a3e;--line-2:#2d3b57;--text:#e8ecf3;--muted:#a6b1c2;--faint:#8b97ab;--accent:#2f9fe0;--accent-2:#5bb7ee;--on-accent:#04121f;--accent-soft:rgb(47 159 224/.13);--ok:#4ade80;--ok-soft:rgb(74 222 128/.09);--bad:#f87171;--wait:#fbbf24;--focus:#8fd0f7;--shadow:0 1px 0 rgb(0 0 0/.35);--walk:#38bdf8;--food:#f59e0b;--culture:#a78bfa;--nature:#4ade80;--view:#f472b6;--night:#a5b4fc;--travel:#94a3b8;--sight:#fb923c}
html{background:var(--bg);color:var(--text);font:14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;-webkit-text-size-adjust:100%}
body{margin:0}
button{font:inherit;color:inherit}
:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
[hidden]{display:none!important}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.board{max-width:980px;margin:0 auto;padding:14px 14px 12px}
.eyebrow{display:flex;align-items:center;gap:6px;margin:0;color:var(--accent);font-size:11.5px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}
.tag{margin-left:auto;padding:1px 8px;border:1px solid var(--line-2);border-radius:999px;color:var(--faint);font-size:11px;font-weight:600;letter-spacing:.02em;text-transform:none}
h1{margin:4px 0 9px;font-size:22px;line-height:1.15;font-weight:750;letter-spacing:-.01em;overflow-wrap:anywhere}
.facts{display:flex;flex-wrap:wrap;gap:6px;margin:0;padding:0;list-style:none}
.facts li{padding:3px 10px;border:1px solid var(--line);border-radius:999px;background:var(--sunk);color:var(--muted);font-size:12.5px;white-space:nowrap}
.facts .est{border-color:transparent;background:var(--accent-soft);color:var(--text);font-weight:650}
.bar{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:16px 0 8px}
h2{margin:0;color:var(--faint);font-size:12px;font-weight:700;letter-spacing:.07em;text-transform:uppercase}
.link{min-height:32px;padding:0 4px;border:0;border-radius:6px;background:none;color:var(--accent);font-size:12.5px;font-weight:650;cursor:pointer}
.link:hover{text-decoration:underline}
.list{display:grid;align-items:start;gap:8px;margin:0;padding:0;list-style:none}
.day{overflow:hidden;border:1px solid var(--line);border-radius:12px;background:var(--card);box-shadow:var(--shadow)}
.day h3{margin:0;font:inherit}
.toggle{display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:1px 11px;width:100%;min-height:58px;padding:9px 10px 9px 9px;border:0;background:none;text-align:left;cursor:pointer}
.toggle:hover .theme{color:var(--accent)}
.num{display:grid;place-content:center;grid-row:span 2;width:40px;height:40px;border-radius:10px;background:var(--accent-soft);color:var(--accent);font-size:16px;font-weight:750;line-height:1;text-align:center;font-variant-numeric:tabular-nums}
.num small{display:block;margin-bottom:2px;font-size:9px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}
.when{display:flex;align-items:center;gap:8px;color:var(--faint);font-size:11.5px;font-weight:650}
.dots{display:inline-flex;gap:3px}
.dots i{width:6px;height:6px;border-radius:50%;background:var(--k)}
.theme{grid-column:2;font-size:14px;font-weight:650;line-height:1.25}
.chev{display:grid;grid-row:1/span 2;grid-column:3;color:var(--faint);transition:transform .15s ease}
.toggle[aria-expanded=true] .chev{transform:rotate(180deg)}
.body{padding:0 12px 12px}
.items{margin:0;padding:0;border-top:1px solid var(--line);list-style:none}
.item{display:grid;grid-template-columns:70px 1fr;gap:0 8px;padding:8px 0;border-bottom:1px dashed var(--line)}
.item:last-child{border-bottom:0}
.time{display:flex;flex-direction:column;gap:2px;color:var(--muted);font-size:12.5px;font-weight:700;line-height:1.35;font-variant-numeric:tabular-nums}
.kind{display:inline-flex;align-items:center;gap:5px;color:var(--k);font-size:10px;font-weight:750;letter-spacing:.05em;text-transform:uppercase}
.kind::before{content:"";flex:none;width:7px;height:7px;border-radius:50%;background:var(--k)}
.what b{display:block;font-size:13.5px;font-weight:650;line-height:1.3}
.note{display:block;color:var(--faint);font-size:12.5px}
.k-walk{--k:var(--walk)}.k-food{--k:var(--food)}.k-culture{--k:var(--culture)}.k-nature{--k:var(--nature)}.k-view{--k:var(--view)}.k-night{--k:var(--night)}.k-travel{--k:var(--travel)}.k-sight{--k:var(--sight)}
.more{display:inline-flex;align-items:center;gap:6px;min-height:34px;margin-top:8px;padding:0 12px;border:1px solid var(--line-2);border-radius:8px;background:var(--card);font-size:12.5px;font-weight:650;cursor:pointer}
.more:hover{border-color:var(--accent);color:var(--accent)}
.more+.more{margin-left:6px}
.more[aria-disabled=true]{cursor:progress;opacity:.7}
.more[aria-disabled=true] svg{animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.ghost{height:60px;border:1px solid var(--line);border-radius:12px;background:linear-gradient(90deg,var(--card) 30%,var(--sunk) 50%,var(--card) 70%) 0 0/300% 100%;animation:shimmer 1.4s ease-in-out infinite}
@keyframes shimmer{to{background-position:-150% 0}}
.problem{padding:12px 14px;border:1px solid var(--bad);border-radius:12px;background:var(--card);color:var(--bad)}
.ticket{display:grid;grid-template-columns:auto 1fr;align-items:center;gap:2px 12px;margin-top:14px;padding:12px 14px;border:1px dashed var(--ok);border-radius:12px;background:var(--ok-soft)}
.ticket svg{grid-row:span 3;color:var(--ok)}
.ticket h3{margin:0;color:var(--ok);font-size:11.5px;font-weight:750;letter-spacing:.07em;text-transform:uppercase}
.code{margin:0;font:750 19px/1.25 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:.05em;overflow-wrap:anywhere}
.ticket p{margin:0;color:var(--muted);font-size:12.5px}
.actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}
.actions .btn{flex:1 1 140px}
@media (min-width:560px){.actions .btn{flex:0 0 auto}}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:40px;padding:0 16px;border:1px solid var(--line-2);border-radius:10px;background:var(--card);font-size:13.5px;font-weight:650;cursor:pointer}
.btn:hover:not(:disabled){border-color:var(--accent)}
.btn:disabled{cursor:default;opacity:.5}
.btn[aria-disabled=true]{cursor:progress}
.primary{border-color:var(--accent);background:var(--accent);color:var(--on-accent)}
.primary:hover:not(:disabled){border-color:var(--accent-2);background:var(--accent-2)}
.primary.done{border-color:var(--ok);background:var(--ok-soft);color:var(--ok);opacity:1}
.tool{display:inline-flex;align-items:center;gap:5px;min-height:28px;padding:0 9px;border:1px solid var(--line-2);border-radius:999px;background:var(--card);color:var(--muted);font-size:11.5px;font-weight:650;letter-spacing:0;text-transform:none;cursor:pointer}
.tool:hover{border-color:var(--accent);color:var(--accent)}
.idea{margin:12px 0 0;padding:10px 12px;border:1px solid var(--line);border-left:3px solid var(--accent);border-radius:10px;background:var(--card)}
.idea h3{margin:0 0 2px;color:var(--faint);font-size:11px;font-weight:750;letter-spacing:.07em;text-transform:uppercase}
.idea p{margin:0;font-size:13.5px}
html[data-display=fullscreen] .board{max-width:1180px}
.status{min-height:1.45em;margin:8px 0 0;color:var(--muted);font-size:12.5px}
.status[data-tone=ok]{color:var(--ok)}.status[data-tone=bad]{color:var(--bad)}.status[data-tone=wait]{color:var(--wait)}
.foot{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:2px 12px;margin:8px 0 0;padding-top:6px;border-top:1px solid var(--line);color:var(--faint);font-size:11.5px}
.foot .link{display:inline-flex;align-items:center;gap:4px;padding:0;font-size:12px}
.foot .link:disabled{cursor:default;opacity:.5;text-decoration:none}
@media (min-width:560px){.board{padding:18px 20px 14px}h1{font-size:26px}}
@media (min-width:640px){.list{grid-template-columns:repeat(auto-fill,minmax(270px,1fr))}}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
`

const BODY = `
<main class="board" aria-labelledby="dest">
<header>
<p class="eyebrow"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 14.5s5-4.3 5-8.2A5 5 0 0 0 3 6.3c0 3.9 5 8.2 5 8.2z"/><circle cx="8" cy="6.3" r="1.8"/></svg>Trip board<span class="tag">demo data</span><button type="button" class="tool" id="full" hidden>Full screen</button></p>
<h1 id="dest">Planning your trip…</h1>
<ul class="facts" id="facts" aria-label="The trip"></ul>
</header>
<section aria-labelledby="days-h">
<div class="bar"><h2 id="days-h">Day by day</h2><span><button type="button" class="link" id="download" disabled hidden>Download itinerary</button><button type="button" class="link" id="all" aria-controls="days" hidden>Open all days</button></span></div>
<ol class="list" id="days" aria-busy="true"><li class="ghost" aria-hidden="true"></li><li class="ghost" aria-hidden="true"></li><li class="ghost" aria-hidden="true"></li></ol>
</section>
<section class="ticket" id="ticket" aria-labelledby="ticket-h" hidden>
<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9.5"/><path d="M7.5 12.3l3 3 6-6.3"/></svg>
<h3 id="ticket-h">Demo booking</h3>
<p class="code" id="code"></p>
<p id="ticket-note"></p>
</section>
<div class="actions">
<button type="button" class="btn primary" id="book" disabled>Book this trip</button>
<button type="button" class="btn" id="send" disabled>Send to chat</button>
</div>
<section class="idea" id="idea" aria-labelledby="idea-h" hidden><h3 id="idea-h">From the host’s model</h3><p id="idea-text"></p></section>
<p class="status" id="status" role="status" aria-live="polite"></p>
<footer class="foot"><span>Made-up plans and prices: nothing is booked, charged or kept.</span><button type="button" class="link" id="docs" disabled>How MCP Apps work<svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 2.5h5v5M9.5 2.5l-7 7"/></svg></button></footer>
</main>
`

const script = (docsUrl: string): string => `
(function () {
  'use strict'
  var DOCS = ${literal(docsUrl)}
  var KINDS = { walk: 'Walk', food: 'Food', culture: 'Culture', nature: 'Nature', view: 'View', night: 'Evening', travel: 'Travel', sight: 'Sight' }
  var CHEVRON = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6l4 4 4-4"/></svg>'
  var SHUFFLE = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9"/><path d="M13.5 2.5v3h-3"/></svg>'
  var $ = function (id) { return document.getElementById(id) }
  var host = window.parent

  // The extension's JSON-RPC, over postMessage to the window that framed this document.
  var seq = 0
  var waiting = {}
  var post = function (message) { host.postMessage(message, '*') }
  var request = function (method, params) {
    seq += 1
    var id = 'trip-board-' + seq
    var answer = new Promise(function (resolve, reject) { waiting[id] = { resolve: resolve, reject: reject } })
    post({ jsonrpc: '2.0', id: id, method: method, params: params })
    return answer
  }
  var notify = function (method, params) { post({ jsonrpc: '2.0', method: method, params: params || {} }) }

  window.addEventListener('message', function (event) {
    if (event.source !== host) return
    var m = event.data
    if (!m || typeof m !== 'object' || m.jsonrpc !== '2.0') return
    if (typeof m.method !== 'string') {
      var w = waiting[m.id]
      if (!w) return
      delete waiting[m.id]
      if (m.error) w.reject(new Error(String((m.error && m.error.message) || 'refused')))
      else w.resolve(m.result || {})
      return
    }
    var p = m.params && typeof m.params === 'object' ? m.params : {}
    if (m.id !== undefined) {
      if (m.method === 'ping' || m.method === 'ui/resource-teardown') post({ jsonrpc: '2.0', id: m.id, result: {} })
      else post({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found' } })
      return
    }
    if (m.method === 'ui/notifications/tool-input') showInput(p.arguments)
    else if (m.method === 'ui/notifications/tool-result') showResult(p)
    else if (m.method === 'ui/notifications/tool-cancelled') problem('The call was cancelled' + (p.reason ? ': ' + String(p.reason) : '') + '.')
    else if (m.method === 'ui/notifications/host-context-changed') applyContext(p)
  })

  // The host's context, merged as it changes: its theme wins (else prefers-color-scheme), its
  // display mode and the modes it offers decide the Full screen button.
  var context = { displayMode: 'inline', availableDisplayModes: ['inline'] }
  var caps = {}
  var applyContext = function (ctx) {
    if (!ctx || typeof ctx !== 'object') return
    if (ctx.theme === 'light' || ctx.theme === 'dark') document.documentElement.setAttribute('data-theme', ctx.theme)
    if (typeof ctx.displayMode === 'string') context.displayMode = ctx.displayMode
    if (Array.isArray(ctx.availableDisplayModes)) context.availableDisplayModes = ctx.availableDisplayModes
    syncMode()
  }
  var syncMode = function () {
    var full = context.displayMode === 'fullscreen'
    document.documentElement.setAttribute('data-display', full ? 'fullscreen' : 'inline')
    $('full').hidden = context.availableDisplayModes.indexOf('fullscreen') < 0
    $('full').textContent = full ? 'Exit full screen' : 'Full screen'
  }

  // The height of the content, whenever it changes (measured as the extension's SDK does).
  var autoResize = function () {
    var last = -1
    var queued = false
    var measure = function () {
      if (queued) return
      queued = true
      requestAnimationFrame(function () {
        queued = false
        var html = document.documentElement
        var before = html.style.height
        html.style.height = 'max-content'
        var height = Math.ceil(html.getBoundingClientRect().height)
        html.style.height = before
        if (height !== last) {
          last = height
          notify('ui/notifications/size-changed', { width: Math.ceil(window.innerWidth), height: height })
        }
      })
    }
    measure()
    var observer = new ResizeObserver(measure)
    observer.observe(document.documentElement)
    observer.observe(document.body)
  }

  // ── rendering: text only ──
  var el = function (tag, props, children) {
    var node = document.createElement(tag)
    Object.keys(props || {}).forEach(function (key) {
      var value = props[key]
      if (value === undefined || value === false) return
      if (key === 'text') node.textContent = String(value)
      else if (key === 'onclick') node.addEventListener('click', value)
      else node.setAttribute(key, value === true ? '' : String(value))
    })
    ;(children || []).forEach(function (child) { if (child) node.append(child) })
    return node
  }
  var icon = function (svg, cls) {
    var holder = document.createElement('span')
    holder.innerHTML = svg
    var node = holder.firstChild
    if (cls) node.setAttribute('class', cls)
    return node
  }
  var dateOf = function (iso) { return new Date(String(iso) + 'T00:00:00Z') }
  var fmt = function (iso, options) {
    try { return new Intl.DateTimeFormat('en-GB', Object.assign({ timeZone: 'UTC' }, options)).format(dateOf(iso)) } catch (err) { return String(iso) }
  }
  var dayLabel = function (iso) { return fmt(iso, { weekday: 'short', day: 'numeric', month: 'short' }) }
  var money = function (value) { return new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(value) }
  var plural = function (n, word) { return n + ' ' + word + (n === 1 ? '' : 's') }
  var capital = function (word) { return String(word).charAt(0).toUpperCase() + String(word).slice(1) }
  var kindOf = function (kind) { return KINDS[kind] ? kind : 'travel' }
  var textOf = function (result) {
    return ((result && result.content) || []).filter(function (c) { return c && c.type === 'text' }).map(function (c) { return c.text }).join(' ')
  }
  var say = function (text, tone) {
    var status = $('status')
    status.textContent = text
    if (tone) status.setAttribute('data-tone', tone)
    else status.removeAttribute('data-tone')
  }

  var trip = null
  var estimate = null
  var days = []
  var variants = []
  var open = {}
  var busy = {}
  var booked = null
  var booking = false

  var showInput = function (args) {
    if (trip || !args || typeof args.destination !== 'string') return
    $('dest').textContent = args.destination
    var facts = []
    if (typeof args.nights === 'number') facts.push(plural(args.nights, 'night'))
    if (typeof args.travellers === 'number') facts.push(plural(args.travellers, 'traveller'))
    $('facts').replaceChildren.apply($('facts'), facts.map(function (t) { return el('li', { text: t }) }))
  }

  var showResult = function (result) {
    var sc = result && result.structuredContent
    if (result.isError || !sc || !sc.trip || !Array.isArray(sc.days)) {
      problem(textOf(result) || 'The server sent no plan.')
      return
    }
    trip = sc.trip
    estimate = sc.estimate
    days = sc.days
    variants = days.map(function (d) { return d.variant || 0 })
    open = {}
    if (days[0]) open[days[0].day] = true
    $('dest').textContent = trip.destination
    renderFacts()
    var list = $('days')
    list.removeAttribute('aria-busy')
    list.replaceChildren.apply(list, days.map(card))
    $('all').hidden = days.length < 2
    syncAll()
    $('book').disabled = false
    $('send').disabled = false
    $('download').disabled = false
    renderTicket()
  }

  var problem = function (text) {
    var list = $('days')
    list.removeAttribute('aria-busy')
    list.replaceChildren(el('li', { class: 'problem', role: 'alert', text: text }))
    $('all').hidden = true
    if (!trip) $('dest').textContent = 'No plan this time'
  }

  // 1–4 Dec 2026, 29 Nov – 2 Dec 2026, 30 Dec 2026 – 2 Jan 2027.
  var range = function () {
    var a = dateOf(trip.start)
    var b = dateOf(trip.end)
    var last = fmt(trip.end, { day: 'numeric', month: 'short', year: 'numeric' })
    if (a.getUTCFullYear() !== b.getUTCFullYear()) return fmt(trip.start, { day: 'numeric', month: 'short', year: 'numeric' }) + ' – ' + last
    if (a.getUTCMonth() !== b.getUTCMonth()) return fmt(trip.start, { day: 'numeric', month: 'short' }) + ' – ' + last
    return a.getUTCDate() + '–' + last
  }

  var renderFacts = function () {
    var facts = [plural(trip.nights, 'night'), trip.start ? range() : '', plural(trip.travellers, 'traveller'), capital(trip.budget)]
    var items = facts.filter(Boolean).map(function (t) { return el('li', { text: t }) })
    if (estimate) items.push(el('li', { class: 'est', text: '≈ ' + money(estimate.total), title: 'In all, made-up prices: ' + money(estimate.perPerson) + ' each' }))
    $('facts').replaceChildren.apply($('facts'), items)
  }

  var item = function (it) {
    return el('li', { class: 'item' }, [
      el('span', { class: 'time' }, [it.time, el('span', { class: 'kind k-' + kindOf(it.kind), text: KINDS[kindOf(it.kind)] })]),
      el('span', { class: 'what' }, [el('b', { text: it.title }), el('span', { class: 'note', text: it.note })]),
    ])
  }

  var card = function (d) {
    var id = 'day-' + d.day
    var isOpen = Boolean(open[d.day])
    var when = d.date ? dayLabel(d.date) : plural(d.items.length, 'plan')
    var toggle = el('button', {
      type: 'button', class: 'toggle', id: id + '-toggle', 'aria-expanded': String(isOpen), 'aria-controls': id + '-body',
      onclick: function () { setOpen(d.day, !open[d.day]) },
    }, [
      el('span', { class: 'num', 'aria-hidden': 'true' }, [el('small', { text: 'Day' }), String(d.day)]),
      el('span', { class: 'when' }, [
        el('span', { class: 'sr', text: 'Day ' + d.day + ', ' }),
        when,
        el('span', { class: 'dots', 'aria-hidden': 'true' }, d.items.map(function (it) { return el('i', { class: 'k-' + kindOf(it.kind) }) })),
      ]),
      el('span', { class: 'theme', text: d.theme }),
      icon(CHEVRON, 'chev'),
    ])
    var more = el('button', {
      type: 'button', class: 'more', 'aria-label': 'Other ideas for day ' + d.day,
      onclick: function () { reshuffle(d.day) },
    }, [icon(SHUFFLE), 'Other ideas'])
    var idea = el('button', {
      type: 'button', class: 'more dinner', 'aria-label': 'Suggest a dinner place for day ' + d.day, hidden: !caps.sampling,
      onclick: function () { dinner(d.day) },
    }, ['Dinner idea'])
    var body = el('div', { class: 'body', id: id + '-body', hidden: !isOpen }, [el('ol', { class: 'items', 'aria-label': 'Plans for day ' + d.day }, d.items.map(item)), more, idea])
    return el('li', { class: 'day', 'data-day': d.day }, [el('h3', {}, [toggle]), body])
  }

  var cardOf = function (day) { return $('days').querySelector('[data-day="' + day + '"]') }

  var setOpen = function (day, value) {
    open[day] = value
    var node = cardOf(day)
    if (!node) return
    node.querySelector('.toggle').setAttribute('aria-expanded', String(value))
    node.querySelector('.body').hidden = !value
    syncAll()
  }

  var allOpen = function () { return days.every(function (d) { return open[d.day] }) }
  var syncAll = function () { $('all').textContent = allOpen() ? 'Close all days' : 'Open all days' }

  // Another plan for one day: a tool of the server only the app may call (it changes nothing).
  var reshuffle = function (day) {
    if (busy[day] || !trip) return
    var i = day - 1
    var button = cardOf(day).querySelector('.more')
    busy[day] = true
    button.setAttribute('aria-disabled', 'true')
    say('Asking the server for other ideas for day ' + day + '…')
    var args = { destination: trip.destination, day: day, days: days.length, variant: (variants[i] + 1) % 1000 }
    if (trip.start) args.start = trip.start
    request('tools/call', { name: 'reshuffle_day', arguments: args }).then(function (result) {
      var sc = result && result.structuredContent
      if (result.isError || !sc || !Array.isArray(sc.items)) throw new Error(textOf(result) || 'no plan came back')
      var focused = document.activeElement === button
      days[i] = sc
      variants[i] = sc.variant
      var fresh = card(sc)
      cardOf(day).replaceWith(fresh)
      if (focused) fresh.querySelector('.more').focus()
      if (booked) { booked = null; renderTicket() }
      say('New ideas for day ' + day + ': ' + sc.items.map(function (it) { return it.title }).join(' · ') + '.', 'ok')
    }).catch(function (err) {
      say('No other ideas this time: ' + err.message, 'bad')
    }).then(function () {
      busy[day] = false
      var now = cardOf(day)
      if (now) now.querySelector('.more').removeAttribute('aria-disabled')
    })
  }

  var tripArgs = function () {
    var args = { destination: trip.destination, nights: trip.nights, travellers: trip.travellers, budget: trip.budget, variants: variants.slice() }
    if (trip.start) args.start = trip.start
    return args
  }

  var renderTicket = function () {
    var book = $('book')
    $('ticket').hidden = !booked
    book.disabled = Boolean(booked)
    book.classList.toggle('done', Boolean(booked))
    if (!booked) {
      book.textContent = 'Book this trip'
      return
    }
    $('code').textContent = booked.confirmation
    var t = booked.trip
    var parts = [t.destination, t.start ? range() : plural(t.nights, 'night'), plural(t.travellers, 'traveller'), money(booked.total)]
    $('ticket-note').textContent = parts.join(' · ') + '. Nothing was booked or charged: the code is computed from the trip.'
    book.textContent = 'Booked ✓'
  }

  // A demo booking: a write as far as the host knows, so the host asks the user first.
  var book = function () {
    if (booking || booked || !trip) return
    booking = true
    var button = $('book')
    button.setAttribute('aria-disabled', 'true')
    button.textContent = 'Waiting for your OK…'
    say('The host asks you before the app may book anything.', 'wait')
    request('tools/call', { name: 'book_trip', arguments: tripArgs() }).then(function (result) {
      var sc = result && result.structuredContent
      if (result.isError || !sc || typeof sc.confirmation !== 'string') throw new Error(textOf(result) || 'no confirmation came back')
      booked = sc
      say('Booked, as a demo: ' + sc.confirmation + '.', 'ok')
    }).catch(function (err) {
      say(/denied/i.test(err.message) ? 'Not booked: you said no.' : 'Not booked: ' + err.message, 'bad')
    }).then(function () {
      booking = false
      button.removeAttribute('aria-disabled')
      renderTicket()
    })
  }

  // The plan as a message for the user's message box (the host asks; the user sends it, or not).
  var send = function () {
    if (!trip) return
    var lines = days.map(function (d) { return 'day ' + d.day + (d.date ? ' (' + dayLabel(d.date) + ')' : '') + ' ' + d.theme.toLowerCase() })
    var head = 'My trip board for ' + trip.destination + ': ' + plural(trip.nights, 'night') + (trip.start ? ' from ' + dayLabel(trip.start) : '') + ', ' + plural(trip.travellers, 'traveller') + '. '
    var text = head + capital(lines.join('; ')) + '.' + (booked ? ' Demo booking ' + booked.confirmation + '.' : '') + ' What would you change?'
    say('Waiting for your OK…', 'wait')
    request('ui/message', { role: 'user', content: [{ type: 'text', text: text }] }).then(function () {
      say('It is in your message box: edit it, and send it when you like.', 'ok')
    }).catch(function (err) {
      say(/denied/i.test(err.message) ? 'Not put in the message box: you said no.' : 'Not sent: ' + err.message, 'bad')
    })
  }

  // Full screen and back: the host decides, and answers the mode the board is in.
  var setMode = function (mode) {
    request('ui/request-display-mode', { mode: mode }).then(function (result) {
      applyContext({ displayMode: result.mode })
      if (result.mode !== mode) say('The host kept the board ' + result.mode + '.', 'wait')
    }).catch(function (err) {
      say('No full screen: ' + err.message, 'bad')
    })
  }
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && context.displayMode === 'fullscreen') setMode('inline')
  })

  var NL = String.fromCharCode(10)
  var slug = function (text) { return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'trip' }

  // The plan as a text file the host saves (the board itself can save nothing: it is sandboxed).
  var download = function () {
    if (!trip) return
    var lines = ['Trip board: ' + trip.destination, [plural(trip.nights, 'night'), trip.start ? range() : '', plural(trip.travellers, 'traveller'), capital(trip.budget) + ' budget'].filter(Boolean).join(' · '), '']
    days.forEach(function (d) {
      lines.push('Day ' + d.day + (d.date ? ' (' + dayLabel(d.date) + ')' : '') + ': ' + d.theme)
      d.items.forEach(function (it) { lines.push('  ' + it.time + '  ' + it.title + ' - ' + it.note) })
    })
    if (estimate) lines.push('', 'Rough estimate: ' + money(estimate.total) + ' in all (made-up prices).')
    if (booked) lines.push('Demo booking: ' + booked.confirmation + ' (nothing was booked).')
    lines.push('', 'Demo data from the trip board: nothing is booked, charged or kept.')
    var name = slug(trip.destination) + '-itinerary.txt'
    say('Waiting for your OK…', 'wait')
    request('ui/download-file', { contents: [{ type: 'resource', resource: { uri: 'file:///' + name, mimeType: 'text/plain', text: lines.join(NL) + NL } }] }).then(function (result) {
      if (result && result.isError) say('Not saved: you said no.', 'bad')
      else say('Saved as ' + name + '.', 'ok')
    }).catch(function (err) {
      say('Not saved: ' + err.message, 'bad')
    })
  }

  // One idea from the HOST's model (sampling): the host asks the user first, and the answer comes
  // back here only.
  var dinner = function (day) {
    if (!trip) return
    var ask = 'Suggest one place for dinner on the evening of day ' + day + ' of a trip to ' + trip.destination + ' for ' + plural(trip.travellers, 'traveller') + ' on a ' + trip.budget + ' budget. One short sentence: the kind of place and the area.'
    say('Waiting for your OK…', 'wait')
    request('sampling/createMessage', {
      messages: [{ role: 'user', content: { type: 'text', text: ask } }],
      systemPrompt: 'You suggest one dinner place for a traveller. Answer in one short sentence, with no list.',
      maxTokens: 120,
    }).then(function (result) {
      var text = result && result.content && result.content.type === 'text' ? String(result.content.text || '').trim() : ''
      if (!text) throw new Error('no answer came back')
      $('idea-text').textContent = text
      $('idea').hidden = false
      say('An idea from the host’s model is below the board.', 'ok')
    }).catch(function (err) {
      say(/rejected|denied/i.test(err.message) ? 'No suggestion: you said no.' : 'No suggestion: ' + err.message, 'bad')
    })
  }

  var docs = function () {
    say('Waiting for your OK…', 'wait')
    request('ui/open-link', { url: DOCS }).then(function () {
      say('The docs are open in a new tab.', 'ok')
    }).catch(function (err) {
      say(/denied/i.test(err.message) ? 'Not opened: you said no.' : 'Not opened: ' + err.message, 'bad')
    })
  }

  $('all').addEventListener('click', function () {
    var value = !allOpen()
    days.forEach(function (d) { setOpen(d.day, value) })
  })
  $('book').addEventListener('click', book)
  $('send').addEventListener('click', send)
  $('docs').addEventListener('click', docs)
  $('full').addEventListener('click', function () { setMode(context.displayMode === 'fullscreen' ? 'inline' : 'fullscreen') })
  $('download').addEventListener('click', download)

  request('ui/initialize', {
    appInfo: { name: 'trip-board', version: '1.0.0' },
    appCapabilities: { availableDisplayModes: ['inline', 'fullscreen'] },
    protocolVersion: '2026-01-26',
  }).then(function (result) {
    applyContext(result.hostContext)
    // What the host offers besides: a file saved for the user, an answer of its model.
    caps = (result && result.hostCapabilities) || {}
    $('download').hidden = !caps.downloadFile
    Array.prototype.forEach.call(document.querySelectorAll('.dinner'), function (b) { b.hidden = !caps.sampling })
    notify('ui/notifications/initialized', {})
    $('docs').disabled = false
    autoResize()
  }).catch(function (err) {
    problem('The host did not start the app: ' + err.message)
  })
})()
`

/**
 * The script as it is sent: without its indentation and its whole-line comments (they are for the
 * reader of this file; the answer stays well under half of `DEMO_LIMITS.responseBytes`). Safe for
 * this script only: no string or template in it spans a line.
 */
const shipped = (code: string): string =>
  code
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('//'))
    .join('\n')

/** The app's document; `docsUrl` is what "How MCP Apps work" asks the host to open. */
export const tripBoardHtml = (docsUrl: string): string =>
  '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width, initial-scale=1">' +
  '<meta name="color-scheme" content="light dark"><title>Trip board</title>' +
  `<style>${STYLE}</style></head><body>${BODY}<script>${shipped(script(docsUrl))}</script></body></html>`
