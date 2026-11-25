// Beat the Heat Scorekeeper. Works on its own (GitHub Pages) and on the Game Night server, which also saves every round to SQLite.
"use strict";

// ------------------------------------------------------------------ auto-save to the Game Night server
// When this page is served by game-night-server, every save also goes to its SQLite database.
// On GitHub Pages there's no /api, the health check fails, and this quietly does nothing.
const Sync = (() => {
  let enabled = false, sending = false;
  const queue = new Map(), failed = new Map();   // keyed by game id, so two games never overwrite each other
  const ready = fetch("/api/health", { cache: "no-store" })
    .then((r) => r.ok && (r.headers.get("content-type") || "").includes("json"))
    .then((ok) => { enabled = Boolean(ok); if (enabled) show("Connected to the game server"); })
    .catch(() => {});

  function show(text, bad = false) {
    const el = document.getElementById("syncStatus");
    if (el) { el.textContent = text; el.style.color = bad ? "var(--red, #c00)" : ""; }
  }

  // Each save sends the whole game, so a later save also fixes any earlier one that failed.
  async function save(id, gameType, state) {
    await ready;
    if (!enabled || !id) return;
    queue.set(id, JSON.stringify({ game_type: gameType, state }));  // newer state for the same game replaces older
    flush();
  }

  async function flush() {
    if (sending) return;            // the running loop picks up anything queued meanwhile
    sending = true;
    while (queue.size) {
      const [id, body] = queue.entries().next().value;
      queue.delete(id);
      try {
        const r = await fetch(`/api/games/${encodeURIComponent(id)}`, {
          method: "PUT", headers: { "Content-Type": "application/json" }, body,
        });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
        failed.delete(id);
        show("✓ Saved to the game server");
      } catch (err) {
        failed.set(id, body);
        show(`Not saved to the server yet (${err.message}). It will retry on the next save.`, true);
      }
    }
    sending = false;
  }

  const retry = () => { failed.forEach((body, id) => queue.has(id) || queue.set(id, body)); flush(); };
  window.addEventListener("online", retry);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) retry(); });

  return { save, ready: () => ready.then(() => enabled) };
})();

// crypto.randomUUID() only works on https or localhost. Over http://klisby it's undefined,
// so build an id from the time plus random letters instead.
const newGameId = (prefix) => `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

const STORE_KEY = "beattheheat-league:current";
const PALETTE = ["var(--orange)", "var(--red)", "var(--yellow-ink)", "var(--purple)", "var(--blue)", "var(--teal)", "var(--green)"];
const QUICK = [1, 2, 3, 5, 7];

// state = { id, label, players: [...], limit: 66,
//           hands: [[points per player], ...] }     points = flames on the cards each player took that round
let state = load();
if (state && !state.id) state.id = newGameId("bth");
let draft = null;        // [string per player]
let onServer = false;

const $ = (id) => document.getElementById(id);
// Names go into innerHTML, so escape them. Without this, a name like "<img onerror=...>" runs as code.
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (n) => n.toLocaleString("en-US");

// ------------------------------------------------------------------ storage
function load() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || null; } catch { return null; }
}
function save() {
  if (state) Sync.save(state.id, "beattheheat", state);
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch { toast("Couldn't save in this browser. Download the CSV to be safe."); }
}

// ------------------------------------------------------------------ scoring (mirrors gamenight/rules.py)
// Points are bad: everyone adds the flames on the cards they took. When anyone reaches the limit,
// the game ends and the LOWEST total wins.
function computePlayers() {
  const players = state.players.map((name, i) => {
    const pts = state.hands.map((h) => h[i]);
    let run = 0;
    const cum = pts.map((p) => (run += p));
    return { name, seat: i, pts, cum, total: run, clean: pts.filter((p) => p === 0).length, worst: Math.max(0, ...pts) };
  });
  const ranked = [...players].sort((a, b) => a.total - b.total || b.clean - a.clean);
  players.forEach((p, i) => { p.color = PALETTE[i % PALETTE.length]; });
  return { players, ranked };
}
const isOver = (players) => players.some((p) => p.total >= state.limit);

// ------------------------------------------------------------------ setup view
function renderSetup() {
  $("setup").classList.remove("hidden");
  $("game").classList.add("hidden");
  if (!$("nameList").children.length) ["", "", ""].forEach(addNameRow);
}
function addNameRow(value = "") {
  if ($("nameList").children.length >= 10) return ($("setupErr").textContent = "Beat the Heat is for 2 to 10 players.");
  const n = $("nameList").children.length + 1;
  const row = document.createElement("div");
  row.className = "row";
  row.innerHTML = `<input type="text" id="name${n}" aria-label="Player ${n} name" placeholder="Player ${n}" maxlength="20" value="${esc(value)}">
    <button class="iconbtn" type="button" aria-label="Remove player ${n}">×</button>`;
  row.querySelector("button").onclick = () => row.remove();
  $("nameList").appendChild(row);
}
function startGame() {
  const names = [...$("nameList").querySelectorAll("input")].map((i) => i.value.trim()).filter(Boolean);
  if (names.length < 2) return ($("setupErr").textContent = "Add at least two players.");
  if (new Set(names.map((n) => n.toLowerCase())).size !== names.length)
    return ($("setupErr").textContent = "Two players have the same name. Add an initial to tell them apart.");
  const today = new Date().toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  state = { id: newGameId("bth"), label: $("gameLabel").value.trim() || today, players: names,
            limit: Number($("limit").value), hands: [] };
  draft = null;
  save();
  render();
}

// ------------------------------------------------------------------ game view
function render() {
  if (!state) return renderSetup();
  $("setup").classList.add("hidden");
  $("game").classList.remove("hidden");

  const { players, ranked } = computePlayers();
  const over = isOver(players);
  const n = state.hands.length;
  const leader = ranked[0];
  const hottest = [...players].sort((a, b) => b.total - a.total)[0];

  $("gameEyebrow").textContent = `${state.label} · game ends at ${state.limit} · ${n} ${n === 1 ? "round" : "rounds"}`;
  if (!n) {
    $("headline").textContent = "Stay cool";
    $("subline").textContent = `${players.length} players. Fewest flames wins; the game ends when anyone reaches ${state.limit}.`;
  } else if (over) {
    const tied = ranked[1] && ranked[1].total === leader.total;
    $("headline").innerHTML = `<em style="color:${leader.color}">${esc(leader.name)}</em> beat the heat`;
    $("subline").innerHTML = `${esc(hottest.name)} hit ${hottest.total}, ending the game. Lowest total: <strong>${esc(leader.name)} with ${leader.total}</strong>.`
      + (tied ? ` Tied with ${esc(ranked[1].name)}.` : "");
  } else {
    $("headline").innerHTML = `<em style="color:${leader.color}">${esc(leader.name)}</em> is coolest after round ${n}`;
    $("subline").innerHTML = `<strong>${leader.total} ${leader.total === 1 ? "point" : "points"}</strong>. Hottest: ${esc(hottest.name)} at ${hottest.total} of ${state.limit}.`;
  }
  $("heroCard").style.setProperty("--champ", leader.color);
  const big = n ? String(leader.total) : "104";
  $("heroCenter").textContent = big;
  $("heroCenter").classList.toggle("long", big.length >= 3);
  $("heroRibbon").textContent = over ? "Champion" : n ? "Coolest" : "Beat the Heat";
  $("standingsNote").textContent = `Lowest score leads. The game ends when anyone reaches ${state.limit}.`;

  $("entrySection").classList.toggle("hidden", over);
  $("overSection").classList.toggle("hidden", !over);
  $("undoBtn").disabled = !n;
  $("exportBtn").href = `/api/games/${encodeURIComponent(state.id)}.csv`;
  if (over) {
    $("banner").style.setProperty("--champ", leader.color);
    $("banner").innerHTML = `<div class="eyebrow" style="color:#fff;opacity:.85;margin:0">Game over</div>
      <h2>${esc(leader.name)} wins</h2>
      <div>${onServer ? "The game is saved on the server. Start a new one whenever you're ready." : "Download the CSV to keep this game, then start a new one."}</div>
      <div class="row" style="margin-top:8px"><button class="btn small" style="border-color:#fff;color:#fff" type="button" id="bannerUndo">Undo last round</button></div>`;
    $("bannerUndo").onclick = undoHand;
  } else {
    $("entryTitle").textContent = `Round ${n + 1}`;
    if (!draft || draft.length !== players.length) draft = players.map(() => "");
    renderEntry(players);
  }

  renderPodium(ranked);
  renderLadder(players);
  renderChart(players);
}

function renderEntry(players) {
  $("entryRows").innerHTML = players.map((p, i) => `
    <div class="erow" style="--c:${p.color}">
      <div><div class="pname">${esc(p.name)}</div><div class="ptask">${p.total} so far · ${Math.max(0, state.limit - p.total)} to the limit</div></div>
      <button type="button" class="toggle winpick" data-zero="${i}" aria-pressed="${draft[i] === 0 || draft[i] === "0"}">Took none</button>
      <div class="pts">
        <input type="number" inputmode="numeric" min="0" id="v${i}" aria-label="Flames ${esc(p.name)} took" placeholder="Flames taken" value="${draft[i]}">
        <div class="quick">${QUICK.map((v) => `<button type="button" data-add="${i}" data-v="${v}">+${v}</button>`).join("")}<button type="button" data-clear="${i}">Clear</button></div>
      </div>
    </div>`).join("");
}
function setVal(i, v) {
  draft[i] = v;
  $("v" + i).value = v;
  document.querySelector(`[data-zero="${i}"]`).setAttribute("aria-pressed", v === 0);
}
$("entryRows").addEventListener("click", (e) => {
  const t = e.target.closest("button");
  if (!t) return;
  if (t.dataset.zero !== undefined) setVal(+t.dataset.zero, 0);
  else if (t.dataset.add !== undefined) setVal(+t.dataset.add, (Number(draft[+t.dataset.add]) || 0) + Number(t.dataset.v));
  else if (t.dataset.clear !== undefined) setVal(+t.dataset.clear, "");
});
$("entryRows").addEventListener("input", (e) => {
  const m = e.target.id.match(/^v(\d+)$/);
  if (m) draft[+m[1]] = e.target.value;
});

$("entryForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const hand = [];
  for (let i = 0; i < state.players.length; i++) {
    const raw = String(draft[i]).trim(), v = Number(raw);
    if (raw === "") return ($("entryErr").textContent = `How many flames did ${state.players[i]} take? Tap "Took none" for 0.`);
    if (!Number.isInteger(v) || v < 0) return ($("entryErr").textContent = `${state.players[i]}'s flames should be a whole number, 0 or more.`);
    hand.push(v);
  }
  $("entryErr").textContent = "";
  state.hands.push(hand);
  draft = null;
  save();
  render();
  toast(`Round ${state.hands.length} saved`);
});

function undoHand() {
  if (!state.hands.length) return;
  confirmThen(`Remove round ${state.hands.length}? Its points go back into the form.`, () => {
    draft = state.hands.pop().slice();
    save();
    render();
  });
}
$("undoBtn").onclick = undoHand;

function renderPodium(ranked) {
  const sfx = (k) => (k === 1 ? "st" : k === 2 ? "nd" : k === 3 ? "rd" : "th");
  $("podium").innerHTML = ranked.map((p, i) => `
    <article class="pcard" style="--c:${p.color}">
      <div style="display:flex;justify-content:space-between;align-items:end;gap:10px">
        <div class="name">${esc(p.name)}</div><div class="place">${i + 1}${sfx(i + 1)}</div>
      </div>
      <span class="tag">${p.total >= state.limit ? "Hit " + state.limit : (state.limit - p.total) + " to the limit"}</span>
      <dl class="stats num">
        <dt>Score</dt><dd>${p.total}</dd>
        <dt>Clean rounds</dt><dd>${p.clean}</dd>
        <dt>Worst round</dt><dd>${p.worst || "–"}</dd>
      </dl>
    </article>`).join("");
}

function renderLadder(players) {
  const n = state.hands.length;
  $("ladderSection").classList.toggle("hidden", !n);
  const grid = $("ladder");
  grid.style.setProperty("--hands", n || 1);
  let html = "<div></div>";
  for (let h = 1; h <= n; h++) html += `<div class="hh">Round ${h}</div>`;
  players.forEach((p) => {
    html += `<div class="who" style="color:${p.color}">${esc(p.name)}</div>`;
    p.pts.forEach((v, k) => {
      const cls = v === 0 ? "flip7" : "bust";
      html += `<div class="chip ${cls}" style="--c:${p.color};font-size:17px" title="Round ${k + 1}: ${v} points">${v}<small>${v === 0 ? "clean" : ""}</small></div>`;
    });
  });
  grid.innerHTML = html;
}

function renderChart(players) {
  const n = state.hands.length;
  $("raceSection").classList.toggle("hidden", n < 1);
  if (n < 1) return;
  const svg = $("chart"), W = 900, H = 360, L = 48, R = 110, T = 16, B = 40;
  const top = Math.max(state.limit, Math.ceil(Math.max(...players.map((p) => p.total)) / 10) * 10);
  const step = top <= 80 ? 10 : 20;
  const x = (i) => L + (W - L - R) * (i / n), y = (v) => T + (H - T - B) * (1 - v / top);
  let s = "";
  for (let v = 0; v <= top; v += step) s += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)"/><text x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${v}</text>`;
  for (let i = 0; i <= n; i++) s += `<text x="${x(i)}" y="${H - B + 20}" text-anchor="middle">${i === 0 ? "Start" : i}</text>`;
  s += `<line x1="${L}" x2="${W - R}" y1="${y(state.limit)}" y2="${y(state.limit)}" stroke="var(--red)" stroke-width="1.5" stroke-dasharray="6 5"/>`;
  s += `<text x="${L + 6}" y="${y(state.limit) - 6}" style="fill:var(--red);font-weight:700">Too hot: ${state.limit}</text>`;
  players.forEach((p) => {
    const d = [0, ...p.cum].map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
    s += `<path d="${d}" fill="none" stroke="${p.color}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/><circle cx="${x(n)}" cy="${y(p.total)}" r="5" fill="${p.color}"/>`;
  });
  const labels = players.map((p) => ({ p, y: y(p.total) })).sort((a, b) => a.y - b.y);
  labels.forEach((l, i) => { if (i && l.y - labels[i - 1].y < 16) l.y = labels[i - 1].y + 16; });
  labels.forEach(({ p, y: ly }) => (s += `<text x="${W - R + 10}" y="${ly + 4}" style="fill:${p.color};font-weight:700">${esc(p.name)} ${p.total}</text>`));
  svg.innerHTML = s;
  $("chartKey").innerHTML = players.map((p) => `<span style="--c:${p.color}">${esc(p.name)}</span>`).join("");
}

$("newBtn").onclick = () => confirmThen(onServer
  ? "Start a new game? This one stays saved on the server."
  : "Start a new game? This one is cleared from this browser, so download the CSV first if you want to keep it.", () => {
  const names = state.players;
  state = null; draft = null;
  try { localStorage.removeItem(STORE_KEY); } catch {}
  $("nameList").innerHTML = "";
  names.forEach(addNameRow);
  $("gameLabel").value = "";
  render();
});

// ------------------------------------------------------------------ CSV + server/standalone mode
function toCSV() {
  const q = (s) => (/[",\n]/.test(s) ? `"${String(s).replace(/"/g, '""')}"` : s);
  const lines = [`# limit=${state.limit}`, "Round,Player,Points"];
  state.hands.forEach((h, k) => h.forEach((v, i) => lines.push([k + 1, q(state.players[i]), v].join(","))));
  return lines.join("\n") + "\n";
}
$("exportBtn").addEventListener("click", (e) => {
  if (onServer) return;
  e.preventDefault();
  if (!state) return;
  const url = URL.createObjectURL(new Blob([toCSV()], { type: "text/csv" }));
  const name = (state.label || "beat-the-heat").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") + ".csv";
  Object.assign(document.createElement("a"), { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

// ------------------------------------------------------------------ small UI helpers
function confirmThen(text, onYes) {
  $("confirmText").textContent = text;
  $("confirmDlg").classList.remove("hidden");
  $("confirmYes").focus();
  $("confirmYes").onclick = () => { $("confirmDlg").classList.add("hidden"); onYes(); };
  $("confirmNo").onclick = () => $("confirmDlg").classList.add("hidden");
}
let toastTimer;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 2400);
}

$("addName").onclick = () => addNameRow();
$("startGame").onclick = startGame;

Sync.ready().then((ok) => {
  if (!ok) return;
  onServer = true;
  document.querySelectorAll("[data-server]").forEach((el) => (el.hidden = false));
  $("toolsNote").textContent = "Every round saves to the Game Night server as you go.";
});

render();
