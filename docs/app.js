/* PostHog Engineering Impact — UI rendering + tab switching + lazy loaders. */

const COLORS = {
  surviving_code: "#0ea5e9",
  review_leverage: "#22c55e",
  cross_area: "#a855f7",
  incident_work: "#f97316",
  review_centrality: "#eab308",
};
const NAMES = {
  surviving_code: "Surviving code",
  review_leverage: "Review leverage",
  cross_area: "Cross-area reach",
  incident_work: "Incident work",
  review_centrality: "Centrality",
};
const STATE = {
  core: null,        // data.json (always loaded immediately)
  full: null,        // data.full.json (lazy loaded when Explore opened)
  weights: null,     // user-overridden weights for sensitivity slider
  d3: null,          // d3 module (lazy)
};

// ---------- boot ----------

(async function boot() {
  // 1. Try inlined data first (fastest path).
  const inline = document.getElementById("boot-data");
  if (inline) {
    try { STATE.core = JSON.parse(inline.textContent); } catch (_) { /* fall through */ }
  }
  // 2. Otherwise fetch — this is the cold-path and still small (~10KB).
  if (!STATE.core) {
    const r = await fetch("data.json");
    STATE.core = await r.json();
  }
  STATE.weights = { ...STATE.core.weights };
  renderHeader();
  renderBrief();
  wireTabs();
  // Don't load Plotly or full data yet — both are deferred.
})();

// ---------- helpers ----------

function md(s) {
  // tiny markdown: **bold**, `code`, _em_, links [t](u)
  return s
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" class="text-blue-700 hover:underline">$1</a>')
    .replace(/\n/g, "<br>");
}

function avatar(login, size=40) {
  return `<img class="rounded-full border" width="${size}" height="${size}" loading="lazy" decoding="async" src="https://github.com/${login}.png?size=${size*2}" alt="${login}">`;
}

function momentumChip(mom) {
  const map = {
    accelerating: { bg:"#dcfce7", fg:"#166534", arrow:"↑", text:"accelerating" },
    cooling:      { bg:"#fee2e2", fg:"#b91c1c", arrow:"↓", text:"cooling" },
    steady:       { bg:"#f1f5f9", fg:"#475569", arrow:"→", text:"steady" },
  };
  const c = map[mom.label] || map.steady;
  return `<span class="text-[10px] px-1.5 py-0.5 rounded-md pill" style="background:${c.bg};color:${c.fg}" title="last-7d vs prior-83d rate, z=${mom.z.toFixed(2)} (${mom.recent_prs} merged in last 7d)">${c.arrow} ${c.text}</span>`;
}

// ---------- header ----------

function renderHeader() {
  const since = new Date(STATE.core.window_since);
  document.getElementById("meta-line").textContent =
    `${STATE.core.n_prs.toLocaleString()} merged PRs · ${STATE.core.n_eligible} eligible engineers · since ${since.toISOString().slice(0,10)}`;
}

// ---------- Brief tab ----------

function renderBrief() {
  const c = STATE.core;
  // KPIs
  document.getElementById("kpi-prs").textContent = c.n_prs.toLocaleString();
  document.getElementById("kpi-eng").textContent = c.n_eligible;
  document.getElementById("kpi-top").textContent = c.top5[0].score.toFixed(0);

  // Exec brief
  document.getElementById("exec-brief").innerHTML =
    c.exec_brief.map(b => `<li class="flex gap-2"><span class="text-slate-400">▸</span><span>${md(b)}</span></li>`).join("");

  // Top 5 cards
  const cards = document.getElementById("cards");
  cards.innerHTML = c.top5.map(renderCard).join("");

  // Comparison table — with rank delta to make the swap obvious at a glance
  document.getElementById("comparison-table").innerHTML = c.by_pr_count.map(x => {
    const onTop5 = c.top5.find(e => e.login === x.login);
    const delta = x.delta ?? (x.rank_by_impact - (x.rank_by_prs ?? 0));
    let deltaHtml = "";
    if (delta < -1) deltaHtml = `<span class="text-emerald-600 text-[10px] ml-1">↑${Math.abs(delta)}</span>`;
    else if (delta > 1) deltaHtml = `<span class="text-rose-600 text-[10px] ml-1">↓${delta}</span>`;
    else deltaHtml = `<span class="text-slate-400 text-[10px] ml-1">·</span>`;
    return `<tr class="border-t border-slate-100">
      <td class="py-1"><a class="text-blue-700 hover:underline" href="https://github.com/${x.login}" target="_blank">${x.login}</a></td>
      <td class="py-1 text-right pill">${x.pr_count}</td>
      <td class="py-1 text-right pill ${onTop5 ? 'text-emerald-600 font-semibold' : 'text-slate-500'}">#${x.rank_by_impact}${onTop5 ? ' ✓' : ''}${deltaHtml}</td>
    </tr>`;
  }).join("");

  // Area leaders
  document.getElementById("area-leaders").innerHTML = (c.area_leaders || []).slice(0,6).map(r =>
    `<tr class="border-t border-slate-100">
       <td class="py-1"><code class="text-slate-700">${r.area}</code></td>
       <td class="py-1"><a class="text-blue-700 hover:underline" href="https://github.com/${r.leader}" target="_blank">${r.leader}</a></td>
       <td class="py-1 text-right pill text-slate-600">${r.leader_share_pct.toFixed(0)}%</td>
     </tr>`).join("");

  // Lazy-load D3 when the graph card scrolls into view.
  const graphEl = document.getElementById("graph");
  const io = new IntersectionObserver((entries) => {
    if (entries.some(e => e.isIntersecting)) { io.disconnect(); loadD3AndRenderGraph(); }
  }, { rootMargin: "150px" });
  io.observe(graphEl);
}

function sparkline(weekly, primaryColor) {
  if (!weekly || weekly.length === 0) return "";
  const W = 96, H = 22, pad = 2;
  const max = Math.max(1, ...weekly);
  const stepX = (W - pad*2) / (weekly.length - 1 || 1);
  const points = weekly.map((v, i) => {
    const x = pad + i * stepX;
    const y = H - pad - (v / max) * (H - pad*2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  // Area fill under line
  const area = `${pad},${H-pad} ${points} ${(W-pad).toFixed(1)},${H-pad}`;
  return `
    <svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" class="block" aria-label="Weekly PR activity over the 90-day window">
      <polyline points="${area}" fill="${primaryColor}22" stroke="none"/>
      <polyline points="${points}" fill="none" stroke="${primaryColor}" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"/>
    </svg>`;
}

function renderCard(e) {
  const bd = e.breakdown;
  const positives = Object.entries(bd).filter(([_, v]) => v > 0);
  const totalPos = positives.reduce((s, [_, v]) => s + v, 0) || 1;
  const segHTML = positives.map(([k, v]) => {
    const pct = (v/totalPos)*100;
    return `<div class="seg pill" style="width:${pct.toFixed(2)}%; background:${COLORS[k]}" title="${NAMES[k]}: weighted z = +${v.toFixed(2)}"></div>`;
  }).join("");
  const bar = `<div class="flex w-full h-3.5 bg-slate-100 rounded-full overflow-hidden">${segHTML || '<div class="w-full bg-slate-200"></div>'}</div>`;

  const m = e.metrics;
  const primary = e.primary_signal;
  const primaryColor = primary ? COLORS[primary] : "#0ea5e9";

  const stats = [
    ["surviving_code", Math.round(m.surviving_code).toLocaleString(), "lines (capped)"],
    ["review_leverage", m.review_leverage, "deep reviews"],
    ["cross_area", m.cross_area, "areas"],
    ["incident_work", m.incident_work, "incident PRs"],
    ["review_centrality", m.review_centrality.toFixed(3), "PageRank"],
  ].map(([k, v, label]) => {
    const isPrimary = k === primary;
    return `
      <div class="rounded-md py-1 px-1 ${isPrimary ? 'ring-1' : ''}" style="background:${COLORS[k]}1a; ${isPrimary ? `--tw-ring-color:${COLORS[k]};` : ''}">
        <div class="font-semibold pill text-slate-800">${v}</div>
        <div class="text-slate-500">${label}</div>
      </div>`;
  }).join("");

  const peer = e.peer_phrase
    ? `<span class="inline-flex items-center gap-1 text-[11px] text-slate-700 bg-slate-50 border border-slate-200 rounded-full px-2 py-0.5 mr-2"><span class="w-1.5 h-1.5 rounded-full" style="background:${primaryColor}"></span>${e.peer_phrase}</span>`
    : "";

  const sig = e.signature_pr
    ? `<div class="mt-2 border-l-2 pl-2.5 py-0.5" style="border-color:${primaryColor}">
         <div class="text-[10px] uppercase tracking-wide text-slate-400">Signature contribution</div>
         <a class="text-[12px] text-slate-800 hover:underline block truncate" target="_blank" href="https://github.com/PostHog/posthog/pull/${e.signature_pr.number}">#${e.signature_pr.number} · ${e.signature_pr.title.replace(/</g,"&lt;")}</a>
         ${(e.signature_pr.areas||[]).length ? `<div class="mt-0.5">${e.signature_pr.areas.map(a => `<span class="inline-block bg-white border border-slate-200 text-slate-600 rounded px-1.5 py-0.5 text-[10px] mr-1">${a}</span>`).join("")}</div>` : ""}
       </div>`
    : "";

  const otherPRs = (e.top_prs || []).filter(p => !e.signature_pr || p.number !== e.signature_pr.number).slice(0, 1).map(p =>
    `<a class="block truncate text-[11px] text-blue-700 hover:underline mt-0.5" target="_blank" href="https://github.com/PostHog/posthog/pull/${p.number}">#${p.number} · ${p.title.replace(/</g,"&lt;")}</a>`
  ).join("");

  const areas = (e.areas || []).slice(0, 6).map(a => `<span class="inline-block bg-slate-100 text-slate-600 rounded px-1.5 py-0.5 text-[10px] mr-1 mb-1">${a}</span>`).join("");

  const spark = sparkline(e.weekly || [], primaryColor);

  return `
    <article class="bg-white border border-slate-200 rounded-xl p-4 hover:shadow-sm transition-shadow">
      <div class="flex items-start gap-4">
        ${avatar(e.login, 48)}
        <div class="flex-1 min-w-0">
          <div class="flex items-baseline justify-between gap-2 flex-wrap">
            <div class="flex items-baseline gap-2 flex-wrap">
              <span class="text-xs text-slate-400 font-mono">#${e.rank}</span>
              <a href="https://github.com/${e.login}" target="_blank" class="font-semibold text-slate-900 hover:underline">${e.login}</a>
              <span class="text-xs text-slate-500">· ${m.pr_count} merged PRs</span>
              ${momentumChip(e.momentum)}
            </div>
            <div class="flex items-center gap-3">
              <div class="opacity-90" title="Weekly merged-PR cadence over the 90-day window">${spark}</div>
              <div class="text-right">
                <div class="text-xl font-bold pill text-slate-900">${e.score.toFixed(1)}<span class="text-xs font-normal text-slate-400"> / 100</span></div>
                <div class="text-[10px] text-slate-500" title="Σ weight × z-score before normalization">composite z = ${e.raw_composite ? e.raw_composite.toFixed(2) : '—'}</div>
              </div>
            </div>
          </div>
          <div class="text-sm text-slate-700 mt-1">${e.headline} — <span class="text-slate-500">${e.one_liner}</span></div>
          <div class="mt-1.5">${peer}</div>
          <div class="mt-2">${bar}</div>
          <div class="grid grid-cols-5 gap-2 text-[11px] text-center mt-2">${stats}</div>
          ${sig}
          ${otherPRs ? `<div class="mt-1.5"><div class="text-[10px] uppercase tracking-wide text-slate-400">Also notable</div>${otherPRs}</div>` : ""}
          <div class="mt-2 flex flex-wrap">${areas}</div>
        </div>
      </div>
    </article>`;
}

// ---------- D3 force-directed network graph (lazy via dynamic ESM import) ----------

async function loadD3AndRenderGraph() {
  if (!STATE.d3) {
    STATE.d3 = await import("https://cdn.jsdelivr.net/npm/d3@7/+esm");
  }
  renderGraph(STATE.d3);
}

function renderGraph(d3) {
  const container = document.getElementById("graph");
  container.innerHTML = "";
  const W = container.clientWidth || 320;
  const H = container.clientHeight || 220;

  const nodes = STATE.core.graph.nodes.map(n => ({ ...n }));
  const links = STATE.core.graph.edges.map(e => ({ source: e.source, target: e.target, weight: e.weight }));
  const adj = new Map(nodes.map(n => [n.id, new Set()]));
  for (const l of links) { adj.get(l.source)?.add(l.target); adj.get(l.target)?.add(l.source); }

  const svg = d3.select(container).append("svg")
    .attr("viewBox", [0, 0, W, H])
    .attr("width", "100%").attr("height", "100%");

  // One arrowhead per signal color so the marker matches its edge target.
  const defs = svg.append("defs");
  defs.append("marker")
    .attr("id", "arrow").attr("viewBox", "0 -5 10 10").attr("refX", 14).attr("refY", 0)
    .attr("markerWidth", 5).attr("markerHeight", 5).attr("orient", "auto")
    .append("path").attr("d", "M0,-4L8,0L0,4").attr("fill", "#94a3b8");

  const link = svg.append("g").attr("class", "links")
    .attr("stroke", "#94a3b8").attr("stroke-opacity", 0.55)
    .selectAll("line").data(links).join("line")
    .attr("stroke-width", d => 0.8 + Math.log(d.weight + 1) * 1.4)
    .attr("marker-end", "url(#arrow)");
  link.append("title").text(d => `${d.source} → ${d.target} · ${d.weight} reviews`);

  // Edge weight labels (small)
  const linkLabel = svg.append("g").attr("class", "linkLabels")
    .selectAll("text").data(links).join("text")
    .attr("font-size", 9).attr("fill", "#64748b")
    .attr("text-anchor", "middle").attr("paint-order", "stroke")
    .attr("stroke", "white").attr("stroke-width", 3)
    .attr("dy", -3).text(d => d.weight);

  const radius = d => 8 + Math.sqrt((d.centrality || 0) * 10000);
  const colorFor = d => COLORS[d.primary_signal] || "#0ea5e9";

  const node = svg.append("g").attr("class", "nodes").selectAll("g").data(nodes).join("g")
    .style("cursor", "pointer")
    .call(d3.drag()
      .on("start", (e, d) => { if (!e.active) sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
      .on("drag",  (e, d) => { d.fx = e.x; d.fy = e.y; })
      .on("end",   (e, d) => { if (!e.active) sim.alphaTarget(0); d.fx = null; d.fy = null; }));
  node.append("circle")
    .attr("r", radius)
    .attr("fill", colorFor)
    .attr("fill-opacity", 0.85)
    .attr("stroke", "white").attr("stroke-width", 2);
  node.append("title").text(d => `${d.id} · #${d.rank} impact · ${d.pr_count} PRs · PageRank ${d.centrality.toFixed(3)}\nDominant signal: ${(d.primary_signal||"—").replace("_"," ")}`);
  node.append("text").text(d => d.id)
    .attr("font-size", 10).attr("fill", "#0f172a").attr("text-anchor", "middle")
    .attr("font-weight", 600)
    .attr("dy", d => -radius(d) - 6)
    .attr("paint-order", "stroke").attr("stroke", "white").attr("stroke-width", 3);

  // Click-to-highlight neighborhood
  let focused = null;
  const setFocus = (id) => {
    focused = id;
    if (!id) {
      link.attr("stroke-opacity", 0.55);
      node.select("circle").attr("fill-opacity", 0.85);
      linkLabel.attr("fill-opacity", 1);
      return;
    }
    const neighbors = adj.get(id) || new Set();
    link.attr("stroke-opacity", l => (l.source.id === id || l.target.id === id) ? 0.95 : 0.12);
    node.select("circle").attr("fill-opacity", n => (n.id === id || neighbors.has(n.id)) ? 0.95 : 0.18);
    linkLabel.attr("fill-opacity", l => (l.source.id === id || l.target.id === id) ? 1 : 0.15);
  };
  node.on("click", (ev, d) => { setFocus(focused === d.id ? null : d.id); ev.stopPropagation(); });
  svg.on("click", () => setFocus(null));

  // Legend (small, sits at the top-left in SVG units)
  const legendItems = [
    ["surviving_code","code"], ["review_leverage","review"], ["cross_area","breadth"],
    ["incident_work","incidents"], ["review_centrality","central"]
  ];
  const lg = svg.append("g").attr("transform", `translate(6,6)`).attr("font-size", 9).attr("fill", "#475569");
  legendItems.forEach(([k, label], i) => {
    const g = lg.append("g").attr("transform", `translate(${i*64}, 0)`);
    g.append("circle").attr("r", 4).attr("cy", 4).attr("fill", COLORS[k]);
    g.append("text").attr("x", 9).attr("y", 7).text(label);
  });

  const sim = d3.forceSimulation(nodes)
    .force("link", d3.forceLink(links).id(d => d.id).distance(80).strength(0.5))
    .force("charge", d3.forceManyBody().strength(-220))
    .force("center", d3.forceCenter(W / 2, H / 2 + 6))
    .force("collide", d3.forceCollide().radius(d => radius(d) + 8))
    .on("tick", () => {
      link.attr("x1", d => d.source.x).attr("y1", d => d.source.y)
          .attr("x2", d => d.target.x).attr("y2", d => d.target.y);
      linkLabel.attr("x", d => (d.source.x + d.target.x) / 2)
               .attr("y", d => (d.source.y + d.target.y) / 2);
      node.attr("transform", d => `translate(${d.x},${d.y})`);
    });
}

// ---------- Tabs ----------

function wireTabs() {
  const buttons = document.querySelectorAll("#tabs button[data-tab]");
  buttons.forEach(b => b.addEventListener("click", () => switchTab(b.dataset.tab)));
  // Deep-link via URL hash
  const initial = (location.hash || "#brief").slice(1);
  if (["brief","explore","ask","method"].includes(initial)) switchTab(initial);
}

function switchTab(tab) {
  document.querySelectorAll("#tabs button").forEach(b => {
    if (b.dataset.tab === tab) b.classList.add("tab-active","font-medium"), b.classList.remove("text-slate-600");
    else b.classList.remove("tab-active","font-medium"), b.classList.add("text-slate-600");
  });
  ["brief","explore","ask","method"].forEach(t => {
    document.getElementById(`tab-${t}`).classList.toggle("hidden", t !== tab);
  });
  history.replaceState(null, "", `#${tab}`);
  if (tab === "explore") ensureExplore();
  if (tab === "ask") window.AskAI && window.AskAI.init(STATE);
}

// ---------- Explore (lazy) ----------

async function ensureExplore() {
  if (!STATE.full) {
    const r = await fetch("data.full.json");
    STATE.full = await r.json();
    initSliders();
  }
  renderExplore();
}

function initSliders() {
  const root = document.getElementById("sliders");
  root.innerHTML = "";
  for (const [k, v] of Object.entries(STATE.weights)) {
    root.insertAdjacentHTML("beforeend", `
      <div>
        <div class="flex justify-between text-xs">
          <label class="text-slate-700"><span class="inline-block w-2.5 h-2.5 rounded-sm align-middle mr-1" style="background:${COLORS[k]}"></span>${NAMES[k]}</label>
          <span class="pill text-slate-500" data-w-out="${k}">${(v*100).toFixed(0)}%</span>
        </div>
        <input type="range" min="0" max="50" step="1" value="${(v*100).toFixed(0)}" data-w="${k}" class="w-full">
      </div>
    `);
  }
  root.querySelectorAll("input[data-w]").forEach(i => i.addEventListener("input", onWeightChange));
  document.getElementById("reset-weights").addEventListener("click", () => {
    STATE.weights = { ...STATE.core.weights };
    initSliders();
    renderExplore();
  });
}

function onWeightChange(ev) {
  const k = ev.target.dataset.w;
  STATE.weights[k] = parseInt(ev.target.value, 10) / 100;
  document.querySelector(`[data-w-out="${k}"]`).textContent = `${(STATE.weights[k]*100).toFixed(0)}%`;
  renderExplore();
}

function recomputeRanks() {
  const total = Object.values(STATE.weights).reduce((s, v) => s + v, 0) || 1;
  const w = Object.fromEntries(Object.entries(STATE.weights).map(([k,v]) => [k, v/total]));
  const scored = STATE.full.engineers.map(e => {
    let s = 0;
    for (const k of Object.keys(w)) s += w[k] * (e.z[k] ?? 0);
    return { ...e, _composite: s };
  });
  const lo = Math.min(...scored.map(s => s._composite));
  const hi = Math.max(...scored.map(s => s._composite));
  for (const s of scored) s._score = hi === lo ? 50 : 100 * (s._composite - lo) / (hi - lo);
  scored.sort((a,b) => b._composite - a._composite);
  return scored;
}

function renderExplore() {
  const ranked = recomputeRanks();
  const filter = (document.getElementById("explore-search").value || "").toLowerCase();
  const tbody = document.getElementById("explore-table");
  document.getElementById("explore-count").textContent = `(${ranked.length})`;
  tbody.innerHTML = ranked
    .filter(e => !filter || e.login.toLowerCase().includes(filter))
    .slice(0, 200)
    .map((e, i) => {
      const m = e.metrics;
      return `<tr class="border-b border-slate-50 hover:bg-slate-50">
        <td class="py-1.5 px-2 text-slate-400 pill">${i+1}</td>
        <td class="py-1.5 px-2"><a class="text-slate-900 hover:underline" href="https://github.com/${e.login}" target="_blank">${e.login}</a></td>
        <td class="py-1.5 px-2 text-right pill font-semibold">${e._score.toFixed(1)}</td>
        <td class="py-1.5 px-2 text-right pill text-slate-600">${m.pr_count}</td>
        <td class="py-1.5 px-2 text-right pill text-slate-600">${Math.round(m.surviving_code).toLocaleString()}</td>
        <td class="py-1.5 px-2 text-right pill text-slate-600">${m.review_leverage}</td>
        <td class="py-1.5 px-2 text-right pill text-slate-600">${m.cross_area}</td>
        <td class="py-1.5 px-2 text-right pill text-slate-600">${m.incident_work}</td>
        <td class="py-1.5 px-2 text-right pill text-slate-600">${m.review_centrality.toFixed(3)}</td>
      </tr>`;
    }).join("");

  // Top-5 with current weights
  document.getElementById("reweight-top5").innerHTML = ranked.slice(0,5).map(e =>
    `<li><b>${e.login}</b> — ${e._score.toFixed(1)}</li>`).join("");
}

// search input
document.addEventListener("input", e => {
  if (e.target.id === "explore-search") renderExplore();
});

// expose state for Ask AI module
window.STATE = STATE;
