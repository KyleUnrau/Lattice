/**
 * The explorer's single-page UI, served verbatim at `/`. Self-contained (no build step, no
 * external assets): inline CSS and a vanilla-JS client that talks to the `/api/*` endpoints in
 * {@link ./server.ts}. The embedded script deliberately avoids template literals so this outer
 * template literal needs no escaping.
 */
export const PAGE = String.raw`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Lattice — Transaction Explorer</title>
<style>
  :root {
    --bg: #0f1115; --panel: #171a21; --panel2: #1d212b; --line: #2a2f3a;
    --text: #d6dae3; --dim: #8b93a3; --accent: #5b9dff;
    --origin: #8b93a3; --spend: #6b7686; --recapture: #ff8c00;
    --exchange: #2962ff; --residual: #b06bff; --rest: #54c45e; --settle: #1bb6a6;
  }
  * { box-sizing: border-box; }
  body { margin: 0; font: 13px/1.5 -apple-system, Segoe UI, Roboto, sans-serif; background: var(--bg); color: var(--text); }
  header { display: flex; align-items: center; gap: 16px; padding: 10px 16px; background: var(--panel); border-bottom: 1px solid var(--line); position: sticky; top: 0; z-index: 5; }
  header h1 { font-size: 15px; margin: 0; font-weight: 600; letter-spacing: .3px; }
  header h1 span { color: var(--accent); }
  .badge { font-size: 11px; padding: 2px 8px; border-radius: 10px; background: var(--panel2); border: 1px solid var(--line); }
  .badge.ok { color: #54c45e; } .badge.bad { color: #ff6b6b; }
  .cursor { display: flex; align-items: center; gap: 8px; margin-left: auto; }
  .cursor input[type=range] { width: 240px; accent-color: var(--accent); }
  .cursor button { background: var(--panel2); color: var(--text); border: 1px solid var(--line); border-radius: 6px; padding: 3px 9px; cursor: pointer; }
  .cursor button:hover { border-color: var(--accent); }
  .cursor .asof { font-variant-numeric: tabular-nums; color: var(--dim); min-width: 130px; text-align: right; }

  main { display: grid; grid-template-columns: 300px 1fr 420px; gap: 0; height: calc(100vh - 49px); }
  .col { overflow-y: auto; padding: 14px; }
  .col + .col { border-left: 1px solid var(--line); }
  h2 { font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: var(--dim); margin: 0 0 10px; }
  h3 { font-size: 12px; margin: 18px 0 8px; color: var(--dim); text-transform: uppercase; letter-spacing: .8px; }

  /* accounts */
  .acct { padding: 2px 0; }
  .acct .row { display: flex; justify-content: space-between; gap: 8px; padding: 2px 0; }
  .acct .nm { color: var(--text); }
  .acct .kind { font-size: 10px; color: var(--dim); }
  .acct .bal { font-variant-numeric: tabular-nums; color: var(--dim); text-align: right; white-space: nowrap; }
  .acct .children { margin-left: 12px; border-left: 1px solid var(--line); padding-left: 10px; }
  .acct.folder > .row .nm { font-weight: 600; }

  /* timeline */
  .timeline { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 14px; }
  .chip { border: 1px solid var(--line); background: var(--panel); border-radius: 7px; padding: 6px 9px; cursor: pointer; min-width: 64px; }
  .chip:hover { border-color: var(--accent); }
  .chip.sel { border-color: var(--accent); background: var(--panel2); }
  .chip.future { opacity: .38; }
  .chip .t { font-weight: 600; font-size: 12px; }
  .chip .p { font-size: 10px; color: var(--dim); }
  .chip .dots { margin-top: 3px; display: flex; gap: 3px; }
  .dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; }

  /* lines */
  .lines { display: flex; flex-direction: column; gap: 5px; }
  .line { border: 1px solid var(--line); border-left-width: 3px; border-radius: 6px; padding: 7px 9px; background: var(--panel); cursor: pointer; }
  .line:hover { background: var(--panel2); }
  .line .top { display: flex; justify-content: space-between; gap: 8px; }
  .line .role { font-weight: 600; }
  .line .amt { font-variant-numeric: tabular-nums; }
  .line .meta { color: var(--dim); font-size: 11px; margin-top: 2px; display: flex; gap: 8px; flex-wrap: wrap; }
  .tag { display: inline-block; font-size: 10px; padding: 1px 6px; border-radius: 5px; border: 1px solid var(--line); color: var(--dim); cursor: pointer; }
  .tag:hover { border-color: var(--accent); color: var(--text); }
  .cat-origin { border-left-color: var(--origin); }
  .cat-spend { border-left-color: var(--spend); }
  .cat-recapture { border-left-color: var(--recapture); }
  .cat-exchange { border-left-color: var(--exchange); }
  .cat-residual { border-left-color: var(--residual); }
  .cat-rest { border-left-color: var(--rest); }
  .cat-settle { border-left-color: var(--settle); }

  .io { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .io h3 { margin-top: 0; }

  /* basis tree */
  ul.tree { list-style: none; margin: 4px 0; padding-left: 14px; border-left: 1px dashed var(--line); }
  ul.tree li { margin: 3px 0; }
  .node { padding: 3px 7px; border-radius: 5px; background: var(--panel); border: 1px solid var(--line); display: inline-block; }
  .node.exchange { border-left: 3px solid var(--exchange); cursor: pointer; }
  .node.residual { border-left: 3px solid var(--residual); cursor: pointer; }
  .node.origin { border-left: 3px solid var(--origin); }

  /* inspector */
  .kv { display: grid; grid-template-columns: 130px 1fr; gap: 4px 10px; margin: 6px 0; }
  .kv .k { color: var(--dim); }
  .kv .v { font-variant-numeric: tabular-nums; }
  .empty { color: var(--dim); font-style: italic; padding: 20px 0; }
  .pill { display: inline-block; font-size: 11px; padding: 2px 9px; border-radius: 11px; border: 1px solid var(--line); }
  .pill.open { color: var(--exchange); } .pill.partial { color: var(--recapture); } .pill.recaptured { color: var(--rest); }
  .lnk { color: var(--accent); cursor: pointer; }
  .lnk:hover { text-decoration: underline; }
  .legend { display: flex; flex-wrap: wrap; gap: 10px; font-size: 11px; color: var(--dim); margin-top: 6px; }
  .legend span { display: flex; align-items: center; gap: 4px; }
</style>
</head>
<body>
<header>
  <h1>Lattice <span>Explorer</span></h1>
  <span id="valid" class="badge">…</span>
  <div class="cursor">
    <button id="prev" title="Step back">&#8592;</button>
    <input id="slider" type="range" min="0" max="0" value="0" />
    <button id="next" title="Step forward">&#8594;</button>
    <span id="asof" class="asof">as of —</span>
  </div>
</header>
<main>
  <div class="col" id="accounts"></div>
  <div class="col" id="center"></div>
  <div class="col" id="inspector"><div class="empty">Select a transaction line, lot, or exchange to inspect.</div></div>
</main>

<script>
"use strict";
var App = { upTo: null, total: 0, selectedTx: null, inspect: null, state: null };

function api(path) { return fetch(path).then(function (r) { return r.json(); }); }
function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
function byId(id) { return document.getElementById(id); }
function upParam(extra) { var q = App.upTo == null ? "" : "?upTo=" + App.upTo; if (extra) q += (q ? "&" : "?") + extra; return q; }
var CATS = ["origin", "spend", "recapture", "exchange", "residual", "rest", "settle"];

// ---- top-level loaders -------------------------------------------------------------------
function reloadState() {
  return api("/api/state" + upParam()).then(function (s) {
    App.state = s; App.total = s.total;
    if (App.upTo == null) App.upTo = s.upTo;
    renderValidity(s); renderCursor(); renderAccounts(s.accounts); renderTimeline(s.transactions);
  });
}
function reloadTx() {
  if (App.selectedTx == null) { byId("center").innerHTML = renderTimelineHolder() + '<div class="empty">Select a transaction above.</div>'; renderTimeline(App.state.transactions); return; }
  return api("/api/tx/" + App.selectedTx + upParam()).then(renderTransaction);
}
function reloadInspector() {
  var ins = App.inspect;
  if (!ins) { byId("inspector").innerHTML = '<div class="empty">Select a transaction line, lot, or exchange to inspect.</div>'; return; }
  if (ins.kind === "lot") return api("/api/lot/" + ins.id + upParam()).then(renderLot);
  return api("/api/exchange/" + ins.id + upParam()).then(renderExchange);
}
function refreshAll() { reloadState(); reloadTx(); reloadInspector(); }

// ---- navigation --------------------------------------------------------------------------
function setCursor(n) { App.upTo = Math.max(0, Math.min(App.total, n)); refreshAll(); }
function selectTx(i) { App.selectedTx = i; App.upTo = i + 1; refreshAll(); }
function inspectLot(id) { App.inspect = { kind: "lot", id: id }; reloadInspector(); }
function inspectExchange(id) { App.inspect = { kind: "exchange", id: id }; reloadInspector(); }
window.inspectLot = inspectLot; window.inspectExchange = inspectExchange; window.selectTx = selectTx;

// ---- header ------------------------------------------------------------------------------
function renderValidity(s) {
  var b = byId("valid");
  b.className = "badge " + (s.valid ? "ok" : "bad");
  b.textContent = s.valid ? "ledger balanced ✓" : "INVALID: " + s.validationError;
}
function renderCursor() {
  byId("slider").max = App.total; byId("slider").value = App.upTo;
  byId("asof").textContent = "as of t" + (App.upTo - 1) + "  (" + App.upTo + "/" + App.total + ")";
}

// ---- accounts ----------------------------------------------------------------------------
function renderAccounts(accounts) {
  byId("accounts").innerHTML = '<h2>Accounts</h2>' + accounts.map(acctNode).join("");
}
function acctNode(a) {
  var bals = a.balances.map(function (b) { return esc(b.fmt) + " <span style='color:var(--dim)'>" + esc(shortPos(b.position)) + "</span>"; }).join("<br>");
  var kids = a.children && a.children.length ? '<div class="children">' + a.children.map(acctNode).join("") + "</div>" : "";
  return '<div class="acct ' + a.kind + '">'
    + '<div class="row"><span class="nm">' + esc(a.name) + ' <span class="kind">' + a.kind + '</span></span>'
    + '<span class="bal">' + (bals || "<span style='color:var(--line)'>0</span>") + '</span></div>' + kids + '</div>';
}
function shortPos(name) { return name.replace("Canadian Dollars", "CAD").replace("United States Dollars", "USD"); }

// ---- timeline + transaction --------------------------------------------------------------
function renderTimelineHolder() { return '<h2>Transactions</h2><div class="timeline" id="timeline"></div>'; }
function renderTimeline(txs) {
  var center = byId("center");
  if (!center.querySelector("#timeline")) {
    center.innerHTML = renderTimelineHolder() + '<div id="txbody"><div class="empty">Select a transaction above.</div></div>';
  }
  byId("timeline").innerHTML = txs.map(function (t) {
    var dots = CATS.filter(function (c) { return t.categories.indexOf(c) >= 0; })
      .map(function (c) { return '<span class="dot" style="background:var(--' + c + ')" title="' + c + '"></span>'; }).join("");
    var cls = "chip" + (t.index === App.selectedTx ? " sel" : "") + (t.committed ? "" : " future");
    return '<div class="' + cls + '" onclick="selectTx(' + t.index + ')">'
      + '<div class="t">t' + t.index + '</div><div class="p">' + esc(shortPos(t.position)) + '</div>'
      + '<div class="dots">' + dots + "</div></div>";
  }).join("");
}
function renderTransaction(tx) {
  renderTimeline(App.state.transactions);
  var body = '<div class="io"><div><h3>Inputs</h3><div class="lines">' + tx.inputs.map(lineRow).join("")
    + '</div></div><div><h3>Outputs</h3><div class="lines">' + tx.outputs.map(lineRow).join("") + "</div></div></div>";
  body += '<h3>Provenance of consumed value</h3>';
  if (tx.provenance.error) body += '<div class="empty">' + esc(tx.provenance.error) + "</div>";
  else if (!tx.provenance.basis.length) body += '<div class="empty">No consumed lots — this transaction introduces value (no prior basis to trace).</div>';
  else body += '<ul class="tree">' + tx.provenance.basis.map(basisNode).join("") + "</ul>" + originLine(tx.provenance.origin);
  byId("txbody").innerHTML = '<h3 style="margin-top:18px">Transaction t' + tx.index + ' · ' + esc(shortPos(tx.position)) + (tx.committed ? "" : "  (not yet in view)") + "</h3>" + body;
}
function lineRow(l) {
  var tags = "";
  if (l.sourceLotId) tags += '<span class="tag" onclick="event.stopPropagation();inspectLot(\'' + l.sourceLotId + '\')">source &#8594; (avail ' + esc(l.sourceAvailableFmt) + ")</span>";
  if (l.exchangeId) tags += '<span class="tag" onclick="event.stopPropagation();inspectExchange(\'' + l.exchangeId + '\')">exchange ' + esc(l.exchangeId) + "</span>";
  if (l.counterpartLotId) tags += '<span class="tag" onclick="event.stopPropagation();inspectLot(\'' + l.counterpartLotId + '\')">other side</span>';
  var ob = l.originBasis ? '<span class="meta">origin: ' + l.originBasis.map(function (o) { return esc(o.quantityFmt) + " " + esc(shortPos(o.position)); }).join(", ") + "</span>" : "";
  var avail = l.availableFmt != null ? ' · avail ' + esc(l.availableFmt) : "";
  return '<div class="line cat-' + l.category + '" onclick="inspectLot(\'' + l.id + '\')">'
    + '<div class="top"><span class="role">' + esc(l.role) + '</span><span class="amt">' + esc(l.quantityFmt) + " " + esc(shortPos(l.position)) + "</span></div>"
    + '<div class="meta"><span>' + (l.owner ? esc(l.owner.name) : "&mdash;") + "</span><span>" + esc(l.type) + avail + "</span></div>"
    + (tags ? '<div class="meta">' + tags + "</div>" : "") + ob + "</div>";
}

// ---- basis tree (shared) -----------------------------------------------------------------
function basisNode(n) {
  if (n.type === "origin")
    return '<li><span class="node origin">origin · ' + esc(n.quantityFmt) + " " + esc(shortPos(n.position)) + "</span></li>";
  if (n.type === "residual")
    return '<li><span class="node residual" onclick="inspectLot(\'' + n.residualId + '\')">residual · ' + esc(n.quantityFmt) + " " + esc(shortPos(n.position))
      + ' <span style="color:var(--dim)">(origin ' + n.originBasis.map(function (o) { return esc(o.quantityFmt) + " " + esc(shortPos(o.position)); }).join(", ") + ")</span></span></li>";
  var sub = n.basis && n.basis.length ? '<ul class="tree">' + n.basis.map(basisNode).join("") + "</ul>" : "";
  return '<li><span class="node exchange" onclick="inspectExchange(\'' + n.exchangeId + '\')">exchange ' + esc(n.exchangeId) + " · "
    + esc(n.quantityFmt) + " " + esc(shortPos(n.toPosition)) + ' <span style="color:var(--dim)">&#8592; ' + esc(n.fromFmt) + " " + esc(shortPos(n.fromPosition)) + "</span></span>" + sub + "</li>";
}
function originLine(origin) {
  if (!origin || !origin.length) return "";
  return '<div class="kv"><span class="k">origin composition</span><span class="v">'
    + origin.map(function (o) { return esc(o.quantityFmt) + " " + esc(shortPos(o.position)); }).join(" + ") + "</span></div>";
}

// ---- inspector ---------------------------------------------------------------------------
function kv(k, v) { return '<span class="k">' + esc(k) + '</span><span class="v">' + v + "</span>"; }
function txLink(i) { return i == null ? "&mdash;" : '<span class="lnk" onclick="selectTx(' + i + ')">t' + i + "</span>"; }

function renderLot(l) {
  if (l.error) { byId("inspector").innerHTML = '<div class="empty">' + esc(l.error) + "</div>"; return; }
  var h = '<h2>Lot ' + esc(l.id) + "</h2>";
  var rows = kv("type", esc(l.type)) + kv("owner", l.owner ? esc(l.owner.name) : "&mdash;")
    + kv("quantity", esc(l.quantityFmt) + " " + esc(shortPos(l.position)));
  if (l.availableFmt != null) rows += kv("available", esc(l.availableFmt));
  if (l.committed != null) rows += kv("committed", l.committed ? "yes" : "not yet");
  if (l.producedInTx != null) rows += kv("produced in", txLink(l.producedInTx));
  if (l.introducedInTx != null) rows += kv("introduced in", txLink(l.introducedInTx));
  if (l.sourceLotId) rows += kv("draws from", '<span class="lnk" onclick="inspectLot(\'' + l.sourceLotId + '\')">' + esc(l.sourceLotId) + "</span> (avail " + esc(l.sourceAvailableFmt) + ")");
  if (l.exchangeId) rows += kv("exchange", '<span class="lnk" onclick="inspectExchange(\'' + l.exchangeId + '\')">' + esc(l.exchangeId) + "</span>");
  h += '<div class="kv">' + rows + "</div>";

  var cons = l.consumptions || l.settlements;
  if (cons && cons.length) {
    h += "<h3>" + (l.consumptions ? "Consumed by" : "Settled by") + "</h3><div class='kv'>"
      + cons.map(function (c) { return kv(txLink(c.txIndex), esc(c.qtyFmt) + ' <span class="lnk" onclick="inspectLot(\'' + c.byLotId + '\')">(' + esc(c.byLotId) + ")</span>"); }).join("") + "</div>";
  }
  if (l.originBasis && l.originBasis.length)
    h += "<h3>Deferred origin basis</h3>" + originLine(l.originBasis).replace("origin composition", "carries");
  if (l.basis && l.basis.length) {
    h += "<h3>Cost basis trace</h3><ul class='tree'>" + l.basis.map(basisNode).join("") + "</ul>";
    h += '<div class="kv">' + kv("origin composition", l.originComposition.map(function (o) { return esc(o.quantityFmt) + " " + esc(shortPos(o.position)); }).join(" + ")) + "</div>";
  } else if (l.basisError) h += '<div class="empty">' + esc(l.basisError) + "</div>";
  byId("inspector").innerHTML = h;
}

function renderExchange(x) {
  if (x.error) { byId("inspector").innerHTML = '<div class="empty">' + esc(x.error) + "</div>"; return; }
  var h = '<h2>Exchange ' + esc(x.id) + ' <span class="pill ' + x.status + '">' + x.status + "</span></h2>";
  h += '<div class="kv">'
    + kv("account", x.account ? esc(x.account.name) : "&mdash;")
    + kv("from (given)", '<span class="lnk" onclick="inspectLot(\'' + x.from.lotId + '\')">' + esc(x.from.quantityFmt) + " " + esc(shortPos(x.from.position)) + "</span>")
    + kv("to (received)", '<span class="lnk" onclick="inspectLot(\'' + x.to.lotId + '\')">' + esc(x.to.quantityFmt) + " " + esc(shortPos(x.to.position)) + "</span>")
    + kv("locked rate", esc(x.rate.toFixed(6)) + " " + esc(shortPos(x.from.position)) + "/" + esc(shortPos(x.to.position)))
    + kv("recaptured", esc(x.recovered.toFmt) + " " + esc(shortPos(x.to.position)) + "  /  " + esc(x.recovered.fromFmt) + " " + esc(shortPos(x.from.position)))
    + kv("to remaining", esc(x.to.availableFmt) + " " + esc(shortPos(x.to.position)))
    + kv("opened in", txLink(x.openedInTx))
    + kv("received in", txLink(x.receivedInTx))
    + kv("recaptured in", x.recapturedInTx.length ? x.recapturedInTx.map(txLink).join(", ") : "&mdash;")
    + "</div>";
  h += '<div class="empty" style="font-style:normal;font-size:11.5px">An exchange is recaptured when a later disposal’s lineage loops back to its from-position — the basis returns home and the gain/loss is realized.</div>';
  byId("inspector").innerHTML = h;
}

// ---- wire up -----------------------------------------------------------------------------
byId("slider").addEventListener("input", function (e) { setCursor(Number(e.target.value)); });
byId("prev").addEventListener("click", function () { setCursor(App.upTo - 1); });
byId("next").addEventListener("click", function () { setCursor(App.upTo + 1); });
reloadState().then(function () { if (App.total > 0) selectTx(App.total - 1); });
</script>
</body>
</html>`;
