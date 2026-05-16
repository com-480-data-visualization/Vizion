/* ============================================================
   Global Trade Explorer — D3.js frontend (Milestone 3)
   ============================================================ */

"use strict";

// ── Global state ──────────────────────────────────────────────────────────────
const state = {
  commodity: null,
  year: 2023,
  flow: "total",
  selectedIso3: null,
  moversFlow: "total",
  meta: null,
  raceData: null,
  raceTimer: null,
  raceYearIdx: 0,
  commodityColor: "#3b82f6",
  disruptionPartner: null, // non-null = disruption mode active
};

// ── Formatting helpers ────────────────────────────────────────────────────────
function fmtUSD(v) {
  const a = Math.abs(v);
  if (a >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `$${(v / 1e6).toFixed(0)}M`;
  if (a >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// ── Bootstrap ────────────────────────────────────────────────────────────────
async function init() {
  const meta = await fetch("/api/meta").then(r => r.json());
  state.meta = meta;
  state.commodity = meta.available[0];
  state.commodityColor = meta.commodities[state.commodity].color;

  buildCommodityNav(meta);
  buildCompareSelect(meta);
  setupControls(meta);

  await loadWorldMap();
  await refreshMap();
  await refreshMovers();
  await refreshRace();
}

// ── Commodity nav ─────────────────────────────────────────────────────────────
function buildCommodityNav(meta) {
  const nav = document.getElementById("commodity-nav");
  nav.innerHTML = "";
  Object.entries(meta.commodities).forEach(([key, info]) => {
    const pill = document.createElement("span");
    pill.className = "comm-pill" + (key === state.commodity ? " active" : "");
    pill.dataset.key = key;
    pill.textContent = info.label;
    pill.style.color = info.color;
    if (key === state.commodity) pill.style.borderColor = info.color;
    pill.addEventListener("click", () => selectCommodity(key));
    nav.appendChild(pill);
  });
}

function selectCommodity(key) {
  state.commodity = key;
  state.commodityColor = state.meta.commodities[key].color;
  document.querySelectorAll(".comm-pill").forEach(p => {
    const k = p.dataset.key;
    p.classList.toggle("active", k === key);
    p.style.borderColor = k === key ? state.meta.commodities[k].color : "";
  });
  refreshAll();
}

async function refreshAll() {
  await refreshMap();
  if (state.selectedIso3) {
    await refreshSidePanel();
    refreshActiveTab();
  }
  await refreshMovers();
  await refreshRace();
}

// ── Controls ──────────────────────────────────────────────────────────────────
function setupControls(meta) {
  // Year slider
  const slider = document.getElementById("year-slider");
  const display = document.getElementById("year-display");
  const years = meta.years;
  slider.min = years[0];
  slider.max = years[years.length - 1];
  slider.value = years[years.length - 1];
  state.year = +slider.value;
  display.textContent = state.year;

  slider.addEventListener("input", () => {
    state.year = +slider.value;
    display.textContent = state.year;
    refreshMap();
    if (state.selectedIso3) refreshSidePanel();
    refreshMovers();
  });

  // Flow toggle
  document.getElementById("flow-toggle").addEventListener("click", e => {
    const pill = e.target.closest(".radio-pill");
    if (!pill) return;
    document.querySelectorAll("#flow-toggle .radio-pill").forEach(p => p.classList.remove("active"));
    pill.classList.add("active");
    state.flow = pill.dataset.value;
    refreshMap();
  });

  // Movers flow toggle
  document.getElementById("movers-flow-toggle").addEventListener("click", e => {
    const pill = e.target.closest(".radio-pill");
    if (!pill) return;
    document.querySelectorAll("#movers-flow-toggle .radio-pill").forEach(p => p.classList.remove("active"));
    pill.classList.add("active");
    state.moversFlow = pill.dataset.value;
    refreshMovers();
  });

  // Tabs
  document.getElementById("tab-bar").addEventListener("click", e => {
    const btn = e.target.closest(".tab-btn");
    if (!btn) return;
    document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".tab-content").forEach(c => c.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById("tab-" + btn.dataset.tab).classList.add("active");
    refreshActiveTab();
  });

  // Compare select
  document.getElementById("compare-select").addEventListener("change", () => {
    if (state.selectedIso3) drawCompare();
  });

  // Disruption exit
  document.getElementById("disruption-exit-btn").addEventListener("click", deactivateDisruption);
}

function refreshActiveTab() {
  const activeTab = document.querySelector(".tab-btn.active")?.dataset.tab;
  if (!activeTab || !state.selectedIso3) return;
  if (activeTab === "history")    drawHistory();
  if (activeTab === "sankey")     drawSankey();
  if (activeTab === "dependency") drawDependency();
  if (activeTab === "disruption") drawDisruption();
  if (activeTab === "compare")    drawCompare();
}

// ── World map ─────────────────────────────────────────────────────────────────
let projection, path, worldGeo;

async function loadWorldMap() {
  // Use Natural Earth from cdn.jsdelivr.net
  worldGeo = await fetch(
    "https://unpkg.com/world-atlas@2/countries-110m.json"
  ).then(r => r.json());

  const container = document.getElementById("map-container");
  const W = container.getBoundingClientRect().width || 800;
  const H = 480;

  const svg = d3.select("#world-map")
    .attr("width", W)
    .attr("height", H);

  projection = d3.geoNaturalEarth1()
    .scale(W / 6.3)
    .translate([W / 2, H / 2]);

  path = d3.geoPath().projection(projection);

  // Map group — everything inside here zooms/pans
  const mapGroup = svg.append("g").attr("id", "map-group");

  // Graticule
  mapGroup.append("path")
    .datum(d3.geoGraticule()())
    .attr("class", "graticule")
    .attr("d", path);

  // Countries
  const countries = topojson.feature(worldGeo, worldGeo.objects.countries);
  mapGroup.append("g").attr("id", "countries-group")
    .selectAll("path")
    .data(countries.features)
    .join("path")
    .attr("class", "country")
    .attr("d", path)
    .attr("fill", "#334155")
    .on("mouseover", onMapMouseover)
    .on("mousemove", onMapMousemove)
    .on("mouseout",  onMapMouseout)
    .on("click",     onMapClick);

  // Colorbar stays fixed — outside the zoom group
  svg.append("g").attr("id", "colorbar-group");

  // Zoom behaviour — Ctrl+scroll to zoom, drag to pan
  const zoom = d3.zoom()
    .scaleExtent([1, 8])
    .filter(event => {
      if (event.type === "wheel") return event.ctrlKey || event.metaKey;
      return !event.button;
    })
    .on("zoom", (event) => {
      mapGroup.attr("transform", event.transform);
    });

  svg.call(zoom);

  // Double-click: reset view + deselect country
  svg.on("dblclick.zoom", () => {
    svg.transition().duration(500).call(zoom.transform, d3.zoomIdentity);
    state.selectedIso3 = null;
    d3.selectAll(".country").classed("selected", false);
    document.getElementById("analysis-section").style.display = "none";
    document.getElementById("country-info").innerHTML =
      `<p class="placeholder-msg">Click a country on the map to explore its trade.</p>`;
  });

  // Resize handler — reset zoom and reproject
  window.addEventListener("resize", debounce(() => {
    const nW = container.getBoundingClientRect().width;
    svg.attr("width", nW).attr("height", H);
    projection.scale(nW / 6.3).translate([nW / 2, H / 2]);
    path = d3.geoPath().projection(projection);
    mapGroup.select(".graticule").attr("d", path(d3.geoGraticule()()));
    svg.selectAll(".country").attr("d", path);
    svg.call(zoom.transform, d3.zoomIdentity);
    renderColorbar(svg, state._colorScale, state._colorMax, nW, H);
  }, 200));
}

// ── Map refresh ───────────────────────────────────────────────────────────────
async function refreshMap() {
  if (state.disruptionPartner) { await refreshDisruptionMap(); return; }

  const data = await fetch(
    `/api/map/${state.commodity}/${state.year}/${state.flow}`
  ).then(r => r.json());

  const valMap = {};
  data.forEach(d => { valMap[d.reporter_iso3] = d.value; });

  const values = data.map(d => d.value).filter(v => v > 0);
  const q95 = values.length ? d3.quantile(values.sort(d3.ascending), 0.95) : 1;
  const colorMax = q95 || 1;

  const colorScale = d3.scaleSequential()
    .domain([0, colorMax])
    .interpolator(d3.interpolateYlOrRd)
    .clamp(true);

  state._colorScale = colorScale;
  state._colorMax   = colorMax;
  state._valMap     = valMap;

  d3.select("#countries-group").selectAll("path")
    .attr("fill", d => {
      const iso3 = numericToIso3(d.id);
      const v = iso3 ? valMap[iso3] : null;
      return v ? colorScale(v) : "#334155";
    })
    .classed("selected", d => numericToIso3(d.id) === state.selectedIso3)
    .classed("no-data", d => { const iso3 = numericToIso3(d.id); return !iso3 || !valMap[iso3]; })
    .attr("visibility", d => numericToIso3(d.id) ? null : "hidden");

  const W = +d3.select("#world-map").attr("width") || 800;
  renderColorbar(d3.select("#world-map"), colorScale, colorMax, W, 480);
}

// ── Disruption map ────────────────────────────────────────────────────────────
async function refreshDisruptionMap() {
  const partner = state.disruptionPartner;
  const data = await fetch(
    `/api/disruption/${state.commodity}/${encodeURIComponent(partner)}/${state.year}`
  ).then(r => r.json());

  const shareMap = {};
  data.forEach(d => { shareMap[d.iso3] = d.share; });
  state._disruptionShareMap = shareMap;

  const colorScale = d3.scaleSequential()
    .domain([0, 100])
    .interpolator(d3.interpolateReds)
    .clamp(true);

  d3.select("#countries-group").selectAll("path")
    .attr("fill", d => {
      const iso3 = numericToIso3(d.id);
      const v = iso3 ? shareMap[iso3] : null;
      return v ? colorScale(v) : "#334155";
    })
    .classed("selected", d => numericToIso3(d.id) === state.selectedIso3)
    .classed("no-data", d => { const iso3 = numericToIso3(d.id); return !iso3 || !shareMap[iso3]; })
    .attr("visibility", d => numericToIso3(d.id) ? null : "hidden");

  const W = +d3.select("#world-map").attr("width") || 800;
  renderColorbar(d3.select("#world-map"), colorScale, 100, W, 480, `% imports from ${partner}`);
}

async function activateDisruption(partner) {
  state.disruptionPartner = partner;
  document.getElementById("disruption-banner-text").textContent =
    `⚡ Disruption: ${partner} removed as ${state.meta.commodities[state.commodity].label} supplier`;
  document.getElementById("disruption-banner").style.display = "flex";
  await refreshDisruptionMap();
}

function deactivateDisruption() {
  state.disruptionPartner = null;
  document.getElementById("disruption-banner").style.display = "none";
  refreshMap();
}

function renderColorbar(svg, colorScale, colorMax, W, H, label) {
  const g = svg.select("#colorbar-group");
  g.selectAll("*").remove();

  const bW = 120, bH = 10, x0 = W - bW - 16, y0 = H - 30;
  const defs = svg.select("defs").empty() ? svg.append("defs") : svg.select("defs");
  defs.selectAll("#map-gradient").remove();
  const grad = defs.append("linearGradient").attr("id", "map-gradient");
  const steps = 10;
  d3.range(steps + 1).forEach(i => {
    grad.append("stop")
      .attr("offset", `${(i / steps) * 100}%`)
      .attr("stop-color", colorScale(colorMax * i / steps));
  });

  g.append("rect").attr("x", x0).attr("y", y0).attr("width", bW).attr("height", bH)
    .attr("rx", 3).attr("fill", "url(#map-gradient)");
  g.append("text").attr("x", x0).attr("y", y0 - 4).text("0")
    .attr("fill", "#94a3b8").attr("font-size", 10);
  g.append("text").attr("x", x0 + bW).attr("y", y0 - 4)
    .text(label || fmtUSD(colorMax)).attr("text-anchor", "end")
    .attr("fill", "#94a3b8").attr("font-size", 10);
}

// ── Map tooltips & click ──────────────────────────────────────────────────────
const tooltip = document.getElementById("map-tooltip");

function getCountryName(iso3) {
  const entry = state.meta?.countries?.find(c => c.iso3 === iso3);
  return entry ? entry.name : iso3;
}

function onMapMouseover(event, d) {
  const iso3 = numericToIso3(d.id);
  if (!iso3) return;
  if (state.disruptionPartner) {
    const share = state._disruptionShareMap?.[iso3];
    if (!share) return;
    tooltip.innerHTML = `<strong>${getCountryName(iso3)}</strong><br>${share.toFixed(1)}% from ${state.disruptionPartner}`;
  } else {
    const val = state._valMap?.[iso3];
    if (!val) return;
    tooltip.innerHTML = `<strong>${getCountryName(iso3)}</strong><br>${fmtUSD(val)}`;
  }
  tooltip.classList.add("visible");
}

function onMapMousemove(event) {
  const rect = document.getElementById("map-container").getBoundingClientRect();
  tooltip.style.left = (event.clientX - rect.left + 12) + "px";
  tooltip.style.top  = (event.clientY - rect.top  - 10) + "px";
}

function onMapMouseout() {
  tooltip.classList.remove("visible");
}

async function onMapClick(event, d) {
  const iso3 = numericToIso3(d.id);
  if (!iso3 || !state._valMap?.[iso3]) return;
  state.selectedIso3 = iso3;

  // Highlight
  d3.select("#countries-group").selectAll("path")
    .classed("selected", dd => numericToIso3(dd.id) === iso3);

  document.getElementById("analysis-section").style.display = "block";
  await refreshSidePanel();
  refreshActiveTab();
}

// ── Side panel ────────────────────────────────────────────────────────────────
async function refreshSidePanel() {
  const data = await fetch(
    `/api/country/${state.commodity}/${state.selectedIso3}/${state.year}`
  ).then(r => r.json());

  const panel = document.getElementById("country-info");
  const commInfo = state.meta.commodities[state.commodity];
  const color = commInfo.color;

  if (data.no_data) {
    panel.innerHTML = `
      <p class="country-name">${data.name}</p>
      <p style="color:var(--muted)">No data for ${state.year}.</p>`;
    return;
  }

  const balance = data.trade_balance;
  const balColor = balance >= 0 ? "var(--green)" : "var(--red)";
  const balLabel = balance >= 0 ? "surplus" : "deficit";

  panel.innerHTML = `
    <p class="country-name">${data.name}</p>
    <p class="country-sub" style="color:${color}">${commInfo.label} · ${state.year}</p>
    <div class="stats-row">
      <div class="stat-card">
        <div class="stat-label">Imports</div>
        <div class="stat-value" style="color:var(--imp)">${fmtUSD(data.total_imports)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Exports</div>
        <div class="stat-value" style="color:var(--exp)">${fmtUSD(data.total_exports)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Balance</div>
        <div class="stat-value" style="color:${balColor}">${fmtUSD(balance)}<br>
          <span style="font-size:10px;font-weight:400">${balLabel}</span>
        </div>
      </div>
    </div>
    <p class="panel-section-title" style="color:var(--imp)">Top Import Sources</p>
    <svg class="panel-bar-svg" id="panel-imp-bar"></svg>
    <p class="panel-section-title" style="color:var(--exp)">Top Export Destinations</p>
    <svg class="panel-bar-svg" id="panel-exp-bar"></svg>`;

  drawPanelBar("#panel-imp-bar", data.top_imports, "var(--imp)");
  drawPanelBar("#panel-exp-bar", data.top_exports, "var(--exp)");
}

function drawPanelBar(selector, data, color) {
  const W = 380, ROW = 22, PAD_LEFT = 110;
  const H = data.length * ROW + 4;

  const svg = d3.select(selector).attr("height", H).attr("viewBox", `0 0 ${W} ${H}`);
  svg.selectAll("*").remove();
  if (!data.length) { svg.append("text").attr("x", 4).attr("y", 16).attr("fill", "var(--muted)").attr("font-size", 12).text("No data"); return; }

  const xScale = d3.scaleLinear()
    .domain([0, d3.max(data, d => d.trade_value_usd)])
    .range([0, W - PAD_LEFT - 8]);

  const g = svg.append("g").attr("transform", `translate(${PAD_LEFT},0)`);

  data.forEach((d, i) => {
    const y = i * ROW + 2;
    // Bar
    g.append("rect").attr("x", 0).attr("y", y + 3).attr("height", ROW - 6)
      .attr("width", xScale(d.trade_value_usd)).attr("fill", color).attr("rx", 2).attr("opacity", 0.85);
    // Country label (left of bar)
    svg.append("text").attr("class", "bar-label").attr("x", PAD_LEFT - 4)
      .attr("y", y + ROW / 2 + 4).attr("text-anchor", "end")
      .text(d.partner.length > 16 ? d.partner.slice(0, 14) + "…" : d.partner);
    // Value label (right of bar)
    g.append("text").attr("class", "bar-value")
      .attr("x", xScale(d.trade_value_usd) + 4).attr("y", y + ROW / 2 + 4)
      .text(fmtUSD(d.trade_value_usd));
  });
}

// ── Trade History ─────────────────────────────────────────────────────────────
async function drawHistory() {
  const data = await fetch(
    `/api/timeseries/${state.commodity}/${state.selectedIso3}`
  ).then(r => r.json());

  const el = document.getElementById("tab-history");
  const W = el.clientWidth > 0 ? el.clientWidth - 60 : 700;
  const H = 280;
  const margin = { top: 20, right: 30, bottom: 40, left: 70 };
  const iW = W - margin.left - margin.right;
  const iH = H - margin.top - margin.bottom;

  const svg = d3.select("#history-chart")
    .attr("height", H).attr("viewBox", `0 0 ${W} ${H}`);
  svg.selectAll("*").remove();

  if (!data.length) { svg.append("text").attr("x", 20).attr("y", 40).attr("fill", "var(--muted)").text("No data"); return; }

  const g = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

  const x = d3.scaleLinear().domain(d3.extent(data, d => d.year)).range([0, iW]);
  const y = d3.scaleLinear()
    .domain([0, d3.max(data, d => Math.max(d.total_imports, d.total_exports)) * 1.05])
    .range([iH, 0]);

  // Grid
  g.append("g").attr("class", "grid")
    .call(d3.axisLeft(y).ticks(5).tickSize(-iW).tickFormat(""));

  // Axes
  g.append("g").attr("class", "axis")
    .attr("transform", `translate(0,${iH})`)
    .call(d3.axisBottom(x).tickFormat(d3.format("d")).ticks(6));
  g.append("g").attr("class", "axis")
    .call(d3.axisLeft(y).ticks(5).tickFormat(v => fmtUSD(v)));

  // Year vline
  const selX = x(state.year);
  g.append("line")
    .attr("x1", selX).attr("x2", selX).attr("y1", 0).attr("y2", iH)
    .attr("stroke", "var(--muted)").attr("stroke-dasharray", "4,3").attr("stroke-width", 1);

  const lineImp = d3.line().x(d => x(d.year)).y(d => y(d.total_imports)).curve(d3.curveMonotoneX);
  const lineExp = d3.line().x(d => x(d.year)).y(d => y(d.total_exports)).curve(d3.curveMonotoneX);

  g.append("path").datum(data).attr("fill", "none")
    .attr("stroke", "var(--imp)").attr("stroke-width", 2.5)
    .attr("d", lineImp);
  g.append("path").datum(data).attr("fill", "none")
    .attr("stroke", "var(--exp)").attr("stroke-width", 2.5)
    .attr("d", lineExp);

  // Dots at selected year
  const selRow = data.find(d => d.year === state.year);
  if (selRow) {
    [["total_imports", "var(--imp)"], ["total_exports", "var(--exp)"]].forEach(([k, c]) => {
      g.append("circle").attr("cx", x(selRow.year)).attr("cy", y(selRow[k]))
        .attr("r", 5).attr("fill", c).attr("stroke", "#fff").attr("stroke-width", 1.5);
    });
  }

  // Legend
  document.getElementById("history-legend").innerHTML = `
    <div class="legend-item"><div class="legend-swatch" style="background:var(--imp)"></div>Imports</div>
    <div class="legend-item"><div class="legend-swatch" style="background:var(--exp)"></div>Exports</div>`;
}

// ── Sankey ────────────────────────────────────────────────────────────────────
async function drawSankey() {
  const data = await fetch(
    `/api/sankey/${state.commodity}/${state.selectedIso3}/${state.year}`
  ).then(r => r.json());

  const el = document.getElementById("tab-sankey");
  const W = Math.max(el.getBoundingClientRect().width - 32, 700);
  const H = 500;
  const margin = { top: 16, right: 180, bottom: 16, left: 180 };

  const svg = d3.select("#sankey-chart")
    .attr("width", W)
    .attr("height", H)
    .attr("viewBox", `0 0 ${W} ${H}`);
  svg.selectAll("*").remove();

  if (!data.nodes.length) {
    svg.append("text").attr("x", 20).attr("y", 40).attr("fill", "var(--muted)").text("No bilateral data");
    return;
  }

  const sankey = d3.sankey()
    .nodeWidth(16)
    .nodePadding(12)
    .extent([[margin.left, margin.top], [W - margin.right, H - margin.bottom]]);

  const { nodes, links } = sankey({
    nodes: data.nodes.map(d => ({ ...d })),
    links: data.links.map(d => ({ ...d })),
  });

  const g = svg.append("g");

  // Links
  const linkColor = l => l.type === "import" ? "var(--imp)" : "var(--exp)";

  const linkPaths = g.append("g").selectAll("path")
    .data(links)
    .join("path")
    .attr("class", "sankey-link")
    .attr("d", d3.sankeyLinkHorizontal())
    .attr("stroke", d => linkColor(d))
    .attr("stroke-width", d => Math.max(1, d.width))
    .attr("opacity", 0);

  linkPaths.append("title")
    .text(d => `${d.source.name} → ${d.target.name}\n${fmtUSD(d.value)}`);

  // Animate links in with flow effect using stroke-dasharray
  linkPaths.each(function() {
    const len = this.getTotalLength();
    d3.select(this)
      .attr("stroke-dasharray", `${len} ${len}`)
      .attr("stroke-dashoffset", len)
      .transition().duration(900).ease(d3.easeCubicOut)
      .attr("stroke-dashoffset", 0)
      .attr("opacity", 0.5)
      .on("end", function() {
        d3.select(this).attr("stroke-dasharray", null).attr("stroke-dashoffset", null);
      });
  });

  // Nodes
  const nodeG = g.append("g").selectAll("g")
    .data(nodes)
    .join("g")
    .attr("class", "sankey-node")
    .attr("opacity", 0);

  nodeG.append("rect")
    .attr("x", d => d.x0)
    .attr("y", d => d.y0)
    .attr("height", d => Math.max(1, d.y1 - d.y0))
    .attr("width", d => d.x1 - d.x0)
    .attr("fill", d => d.type === "center" ? state.commodityColor
      : d.type === "import" ? "rgba(249,115,22,0.8)"
      : "rgba(59,130,246,0.8)")
    .attr("rx", 2)
    .append("title")
    .text(d => `${d.name}\n${fmtUSD(d.value)}`);

  // Labels — imports label LEFT of bar, exports label RIGHT of bar
  nodeG.append("text")
    .attr("class", "sankey-label")
    .attr("x", d => d.type === "import" ? d.x0 - 6 : d.type === "export" ? d.x1 + 6 : d.x0 + (d.x1 - d.x0) / 2)
    .attr("y", d => (d.y0 + d.y1) / 2)
    .attr("dy", "0.35em")
    .attr("text-anchor", d => d.type === "import" ? "end" : d.type === "export" ? "start" : "middle")
    .text(d => d.name.length > 20 ? d.name.slice(0, 18) + "…" : d.name);

  // Fade nodes in
  nodeG.transition().duration(600).delay(300).attr("opacity", 1);
}

// ── Dependency ────────────────────────────────────────────────────────────────
async function drawDependency() {
  const data = await fetch(
    `/api/dependency/${state.commodity}/${state.selectedIso3}`
  ).then(r => r.json());

  const el = document.getElementById("tab-dependency");
  const W = el.clientWidth > 0 ? el.clientWidth - 60 : 700;
  const H = 300;
  const margin = { top: 20, right: 100, bottom: 40, left: 56 };
  const iW = W - margin.left - margin.right;
  const iH = H - margin.top - margin.bottom;

  const svg = d3.select("#dependency-chart")
    .attr("height", H).attr("viewBox", `0 0 ${W} ${H}`);
  svg.selectAll("*").remove();

  if (!data.length) {
    svg.append("text").attr("x", 20).attr("y", 40).attr("fill", "var(--muted)").text("No data");
    return;
  }

  const g = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

  const x = d3.scaleLinear().domain([d3.min(data, d => d.year), d3.max(data, d => d.year)]).range([0, iW]);
  const y = d3.scaleLinear().domain([0, 105]).range([iH, 0]);

  // Concentration zones
  const zones = [
    [0, 33, "rgba(34,197,94,0.07)", "Diversified"],
    [33, 66, "rgba(234,179,8,0.07)", "Moderate"],
    [66, 100, "rgba(239,68,68,0.07)", "Concentrated"],
  ];
  zones.forEach(([y0, y1, fill, label]) => {
    g.append("rect").attr("x", 0).attr("y", y(y1)).attr("width", iW)
      .attr("height", y(y0) - y(y1)).attr("fill", fill);
    g.append("text").attr("class", "zone-label")
      .attr("x", iW + 4).attr("y", (y(y0) + y(y1)) / 2 + 4)
      .text(label);
  });

  // Axes
  g.append("g").attr("class", "axis").attr("transform", `translate(0,${iH})`)
    .call(d3.axisBottom(x).tickFormat(d3.format("d")).ticks(6));
  g.append("g").attr("class", "axis")
    .call(d3.axisLeft(y).ticks(5).tickFormat(v => v + "%"));

  // Year vline
  g.append("line")
    .attr("x1", x(state.year)).attr("x2", x(state.year)).attr("y1", 0).attr("y2", iH)
    .attr("stroke", "var(--muted)").attr("stroke-dasharray", "4,3").attr("stroke-width", 1);

  const color = state.commodityColor;

  // Top-3 area
  const area3 = d3.area().x(d => x(d.year)).y0(d => y(d.top1_share)).y1(d => y(d.top3_share)).curve(d3.curveMonotoneX);
  g.append("path").datum(data).attr("fill", color).attr("fill-opacity", 0.08)
    .attr("stroke", color).attr("stroke-width", 1).attr("stroke-dasharray", "4,3")
    .attr("d", area3);

  // Top-1 line
  const line1 = d3.line().x(d => x(d.year)).y(d => y(d.top1_share)).curve(d3.curveMonotoneX);
  g.append("path").datum(data).attr("fill", "none")
    .attr("stroke", color).attr("stroke-width", 2.5).attr("d", line1);

  // Dots with tooltip
  const tip = d3.select("#map-tooltip");
  g.selectAll(".dep-dot")
    .data(data)
    .join("circle")
    .attr("class", "dep-dot")
    .attr("cx", d => x(d.year))
    .attr("cy", d => y(d.top1_share))
    .attr("r", d => d.year === state.year ? 6 : 3)
    .attr("fill", color)
    .attr("stroke", d => d.year === state.year ? "#fff" : "none")
    .attr("stroke-width", 1.5)
    .on("mouseover", (event, d) => {
      const mapRect = document.getElementById("map-container").getBoundingClientRect();
      tip.innerHTML = `<strong>${d.year}</strong><br>#1: ${d.top1_partner}<br>${d.top1_share.toFixed(1)}%`;
      tip.classList.add("visible");
      tip.style.left = (event.clientX - mapRect.left + 12) + "px";
      tip.style.top  = (event.clientY - mapRect.top  - 10) + "px";
    })
    .on("mouseout", () => tip.classList.remove("visible"));

  document.getElementById("dependency-legend").innerHTML = `
    <div class="legend-item"><div class="legend-swatch" style="background:${color}"></div>Top-1 partner share</div>
    <div class="legend-item"><div class="legend-swatch" style="background:${color};opacity:0.3"></div>Top-3 band</div>`;
}

// ── Disruption simulator ──────────────────────────────────────────────────────
async function drawDisruption() {
  const el = document.getElementById("tab-disruption");

  const panel = await fetch(
    `/api/country/${state.commodity}/${state.selectedIso3}/${state.year}`
  ).then(r => r.json());

  if (panel.no_data || !panel.top_imports?.length) {
    el.innerHTML = `<p class="placeholder-msg" style="margin-top:30px">No import data available for ${state.year}.</p>`;
    return;
  }

  const imports = panel.top_imports.slice(0, 8);
  const totalImp = panel.total_imports;
  const countryName = panel.name;

  // Rebuild controls each time (country/year/commodity may have changed)
  const prevVal = el.querySelector("#disruption-partner-sel")?.value;
  el.innerHTML = `
    <div class="disruption-controls">
      <label class="control-label">Simulate removing</label>
      <select id="disruption-partner-sel">
        ${imports.map(d => `<option value="${d.partner}"${d.partner === prevVal ? " selected" : ""}>${d.partner}</option>`).join("")}
      </select>
      <label class="control-label">as a supplier</label>
      <button id="disruption-map-btn" class="play-btn" style="margin-left:8px;">⚡ Show on map</button>
    </div>
    <div id="disruption-annotation"></div>
    <svg id="disruption-chart"></svg>
  `;

  el.querySelector("#disruption-partner-sel")
    .addEventListener("change", () => _renderDisruption(imports, totalImp, countryName));
  el.querySelector("#disruption-map-btn")
    .addEventListener("click", () => activateDisruption(
      el.querySelector("#disruption-partner-sel").value
    ));

  _renderDisruption(imports, totalImp, countryName);
}

function _renderDisruption(imports, totalImp, countryName) {
  const removed = document.getElementById("disruption-partner-sel").value;
  const removedVal = imports.find(d => d.partner === removed)?.trade_value_usd ?? 0;
  const newTotal = Math.max(totalImp - removedVal, 1);

  const rows = imports.map(d => ({
    partner: d.partner,
    isRemoved: d.partner === removed,
    before: d.trade_value_usd / totalImp * 100,
    after:  d.partner === removed ? 0 : d.trade_value_usd / newTotal * 100,
  }));

  // Annotation
  const beforeTop1 = rows[0];
  const afterTop1  = rows.filter(d => !d.isRemoved).sort((a, b) => b.after - a.after)[0];
  const biggestGainer = rows.filter(d => !d.isRemoved)
    .sort((a, b) => (b.after - b.before) - (a.after - a.before))[0];

  let note = `Removing <strong>${removed}</strong> `;
  if (beforeTop1.isRemoved) {
    note += `(#1 supplier at ${beforeTop1.before.toFixed(1)}%) shifts the top position to `
          + `<strong>${afterTop1.partner}</strong> at <strong>${afterTop1.after.toFixed(1)}%</strong>`;
  } else {
    note += `raises the top-partner (<strong>${afterTop1.partner}</strong>) share `
          + `from <strong>${beforeTop1.before.toFixed(1)}%</strong> → <strong>${afterTop1.after.toFixed(1)}%</strong>`;
  }
  if (biggestGainer && biggestGainer.partner !== afterTop1.partner) {
    note += `, with <strong>${biggestGainer.partner}</strong> gaining the most `
          + `(+${(biggestGainer.after - biggestGainer.before).toFixed(1)} pp)`;
  }
  document.getElementById("disruption-annotation").innerHTML =
    `<div class="disruption-note">${note}.</div>`;

  // Chart
  const el  = document.getElementById("tab-disruption");
  const W   = el.getBoundingClientRect().width || 600;
  const PAD_L = 120, PAD_R = 54, ROW = 30;
  const iW  = W - PAD_L - PAD_R;
  const H   = rows.length * ROW + 30;
  const maxShare = d3.max(rows, d => Math.max(d.before, d.after));
  const x   = d3.scaleLinear().domain([0, maxShare]).range([0, iW]);
  const col = state.commodityColor;

  const svg = d3.select("#disruption-chart").attr("height", H);
  svg.selectAll("*").remove();
  const g = svg.append("g").attr("transform", `translate(${PAD_L},10)`);

  rows.forEach((d, i) => {
    const y    = i * ROW;
    const barH = 9;
    const muted = "var(--muted)";

    // Partner label
    svg.append("text")
      .attr("x", PAD_L - 8).attr("y", y + ROW / 2 + 5 + 10)
      .attr("text-anchor", "end").attr("font-size", 11)
      .attr("fill", d.isRemoved ? muted : "var(--text)")
      .attr("text-decoration", d.isRemoved ? "line-through" : "none")
      .text(d.partner.length > 18 ? d.partner.slice(0, 16) + "…" : d.partner);

    // Before bar (gray)
    g.append("rect")
      .attr("x", 0).attr("y", y + 2).attr("width", x(d.before)).attr("height", barH)
      .attr("fill", muted).attr("opacity", 0.45).attr("rx", 2);
    g.append("text").attr("x", x(d.before) + 3).attr("y", y + barH + 1)
      .attr("font-size", 10).attr("fill", muted)
      .text(`${d.before.toFixed(1)}%`);

    // After bar (colored), only if not removed
    if (!d.isRemoved) {
      g.append("rect")
        .attr("x", 0).attr("y", y + barH + 4).attr("width", x(d.after)).attr("height", barH)
        .attr("fill", col).attr("opacity", 0.85).attr("rx", 2);
      g.append("text").attr("x", x(d.after) + 3).attr("y", y + barH * 2 + 5)
        .attr("font-size", 10).attr("fill", col)
        .text(`${d.after.toFixed(1)}%`);
    }
  });

  // Legend
  const lY = rows.length * ROW + 8;
  [[muted, 0.45, "Before"], [col, 0.85, "After removal"]].forEach(([fill, op, label], i) => {
    const lx = i * 110;
    g.append("rect").attr("x", lx).attr("y", lY).attr("width", 12).attr("height", 8)
      .attr("fill", fill).attr("opacity", op).attr("rx", 2);
    g.append("text").attr("x", lx + 16).attr("y", lY + 7)
      .attr("font-size", 10).attr("fill", "var(--muted)").text(label);
  });
}

// ── Compare ───────────────────────────────────────────────────────────────────
async function drawCompare() {
  const iso3B = document.getElementById("compare-select").value;

  // Fetch both
  const [statA, statB, tsA, tsB, depA, depB] = await Promise.all([
    fetch(`/api/country/${state.commodity}/${state.selectedIso3}/${state.year}`).then(r => r.json()),
    iso3B ? fetch(`/api/country/${state.commodity}/${iso3B}/${state.year}`).then(r => r.json()) : Promise.resolve(null),
    fetch(`/api/timeseries/${state.commodity}/${state.selectedIso3}`).then(r => r.json()),
    iso3B ? fetch(`/api/timeseries/${state.commodity}/${iso3B}`).then(r => r.json()) : Promise.resolve([]),
    fetch(`/api/dependency/${state.commodity}/${state.selectedIso3}`).then(r => r.json()),
    iso3B ? fetch(`/api/dependency/${state.commodity}/${iso3B}`).then(r => r.json()) : Promise.resolve([]),
  ]);

  const colorA = state.commodityColor;
  const colorB = "var(--cyan)";
  const nameA = statA.name || state.selectedIso3;
  const nameB = statB?.name || iso3B || "—";

  // Stats cards
  const statsDiv = document.getElementById("compare-stats");
  statsDiv.innerHTML = "";
  if (!iso3B) {
    statsDiv.innerHTML = `<p style="color:var(--muted);padding:8px 0">Select a country above to compare.</p>`;
    return;
  }

  const metrics = [
    ["Imports",       statA.total_imports,  statB?.total_imports  ?? 0],
    ["Exports",       statA.total_exports,  statB?.total_exports  ?? 0],
    ["Trade Balance", statA.trade_balance,  statB?.trade_balance  ?? 0],
  ];
  metrics.forEach(([label, vA, vB]) => {
    statsDiv.insertAdjacentHTML("beforeend", `
      <div class="compare-stat-card">
        <div class="compare-stat-label">${label}</div>
        <div class="compare-stat-vals">
          <span style="color:${colorA}">${fmtUSD(vA)}</span>
          <span class="vs-text">vs</span>
          <span style="color:#06b6d4">${fmtUSD(vB)}</span>
        </div>
      </div>`);
  });

  // Time-series
  drawCompareLine("#compare-ts-chart", tsA, tsB, nameA, nameB, colorA, "var(--cyan)");
  drawCompareDep("#compare-dep-chart", depA, depB, nameA, nameB, colorA, "var(--cyan)");
}

function drawCompareLine(selector, tsA, tsB, nameA, nameB, colorA, colorB) {
  const el = document.getElementById("tab-compare");
  const W = el.clientWidth > 0 ? el.clientWidth - 60 : 700;
  const H = 260;
  const margin = { top: 20, right: 30, bottom: 40, left: 70 };
  const iW = W - margin.left - margin.right;
  const iH = H - margin.top - margin.bottom;

  const svg = d3.select(selector).attr("height", H).attr("viewBox", `0 0 ${W} ${H}`);
  svg.selectAll("*").remove();

  const allData = [...tsA, ...tsB];
  if (!allData.length) return;

  const g = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);
  const x = d3.scaleLinear().domain(d3.extent(allData, d => d.year)).range([0, iW]);
  const y = d3.scaleLinear()
    .domain([0, d3.max(allData, d => Math.max(d.total_imports, d.total_exports)) * 1.05])
    .range([iH, 0]);

  g.append("g").attr("class", "grid")
    .call(d3.axisLeft(y).ticks(5).tickSize(-iW).tickFormat(""));
  g.append("g").attr("class", "axis").attr("transform", `translate(0,${iH})`)
    .call(d3.axisBottom(x).tickFormat(d3.format("d")).ticks(6));
  g.append("g").attr("class", "axis")
    .call(d3.axisLeft(y).ticks(5).tickFormat(v => fmtUSD(v)));

  g.append("line")
    .attr("x1", x(state.year)).attr("x2", x(state.year)).attr("y1", 0).attr("y2", iH)
    .attr("stroke", "var(--muted)").attr("stroke-dasharray", "4,3").attr("stroke-width", 1);

  const pairs = [
    [tsA, colorA, "solid", nameA],
    [tsB, colorB, "5,3", nameB],
  ];
  pairs.forEach(([ts, color, dash, name]) => {
    if (!ts.length) return;
    ["total_imports", "total_exports"].forEach((key, ki) => {
      const dashed = ki === 1 ? (dash === "solid" ? "6,3" : "2,2") : dash;
      const line = d3.line().x(d => x(d.year)).y(d => y(d[key])).curve(d3.curveMonotoneX);
      g.append("path").datum(ts).attr("fill", "none")
        .attr("stroke", color).attr("stroke-width", 2)
        .attr("stroke-dasharray", dashed === "solid" ? null : dashed)
        .attr("d", line);
    });
  });
}

function drawCompareDep(selector, depA, depB, nameA, nameB, colorA, colorB) {
  const el = document.getElementById("tab-compare");
  const W = el.clientWidth > 0 ? el.clientWidth - 60 : 700;
  const H = 200;
  const margin = { top: 16, right: 100, bottom: 40, left: 56 };
  const iW = W - margin.left - margin.right;
  const iH = H - margin.top - margin.bottom;

  const svg = d3.select(selector).attr("height", H).attr("viewBox", `0 0 ${W} ${H}`);
  svg.selectAll("*").remove();

  const allData = [...depA, ...depB];
  if (!allData.length) return;

  const g = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);
  const x = d3.scaleLinear().domain(d3.extent(allData, d => d.year)).range([0, iW]);
  const y = d3.scaleLinear().domain([0, 105]).range([iH, 0]);

  const zones = [
    [0, 33, "rgba(34,197,94,0.07)", "Diversified"],
    [33, 66, "rgba(234,179,8,0.07)", "Moderate"],
    [66, 100, "rgba(239,68,68,0.07)", "Concentrated"],
  ];
  zones.forEach(([y0, y1, fill, label]) => {
    g.append("rect").attr("x", 0).attr("y", y(y1)).attr("width", iW)
      .attr("height", y(y0) - y(y1)).attr("fill", fill);
    g.append("text").attr("class", "zone-label")
      .attr("x", iW + 4).attr("y", (y(y0) + y(y1)) / 2 + 4).text(label);
  });

  g.append("g").attr("class", "axis").attr("transform", `translate(0,${iH})`)
    .call(d3.axisBottom(x).tickFormat(d3.format("d")).ticks(6));
  g.append("g").attr("class", "axis")
    .call(d3.axisLeft(y).ticks(4).tickFormat(v => v + "%"));

  g.append("line")
    .attr("x1", x(state.year)).attr("x2", x(state.year)).attr("y1", 0).attr("y2", iH)
    .attr("stroke", "var(--muted)").attr("stroke-dasharray", "4,3").attr("stroke-width", 1);

  [[depA, colorA, null], [depB, colorB, "5,3"]].forEach(([dep, color, dash]) => {
    if (!dep.length) return;
    const line = d3.line().x(d => x(d.year)).y(d => y(d.top1_share)).curve(d3.curveMonotoneX);
    g.append("path").datum(dep).attr("fill", "none")
      .attr("stroke", color).attr("stroke-width", 2)
      .attr("stroke-dasharray", dash || null)
      .attr("d", line);
  });
}

// ── Top Movers ────────────────────────────────────────────────────────────────
async function refreshMovers() {
  const data = await fetch(
    `/api/movers/${state.commodity}/${state.year}/${state.moversFlow}`
  ).then(r => r.json());

  const subtitle = `${state.year - 1} → ${state.year}  ·  ${state.meta.commodities[state.commodity].label}`;
  document.getElementById("movers-subtitle").textContent = subtitle;

  const section = document.getElementById("movers-section");
  const W = section.clientWidth - 64 || 700;
  const ROW = 26;
  const PAD_LEFT = 170, PAD_RIGHT = 70;
  const H = data.length * ROW + 60;
  const iW = W - PAD_LEFT - PAD_RIGHT;

  const svg = d3.select("#movers-chart").attr("height", H).attr("viewBox", `0 0 ${W} ${H}`);
  svg.selectAll("*").remove();

  if (!data.length) {
    svg.append("text").attr("x", 20).attr("y", 40).attr("fill", "var(--muted)").text("Select a year after 2000");
    return;
  }

  const g = svg.append("g").attr("transform", `translate(${PAD_LEFT},20)`);

  const ext = d3.extent(data, d => d.pct_change);
  const absMax = Math.max(Math.abs(ext[0]), Math.abs(ext[1]));
  const x = d3.scaleLinear().domain([-absMax, absMax]).range([0, iW]);
  const zero = x(0);

  // Grid & zero line
  g.append("line").attr("x1", zero).attr("x2", zero).attr("y1", 0).attr("y2", data.length * ROW)
    .attr("stroke", "var(--border)").attr("stroke-width", 1.5);

  data.forEach((d, i) => {
    const y = i * ROW + 4;
    const barX = d.pct_change >= 0 ? zero : x(d.pct_change);
    const barW = Math.abs(x(d.pct_change) - zero);
    const color = d.pct_change >= 0 ? "var(--green)" : "var(--red)";

    g.append("rect").attr("x", barX).attr("y", y + 2)
      .attr("width", Math.max(1, barW)).attr("height", ROW - 6)
      .attr("fill", color).attr("rx", 2).attr("opacity", 0.85);

    // Country label
    svg.append("text").attr("class", "bar-label")
      .attr("x", PAD_LEFT - 6).attr("y", y + ROW / 2 + 4 + 20)
      .attr("text-anchor", "end")
      .text(d.reporter.length > 22 ? d.reporter.slice(0, 20) + "…" : d.reporter);

    // Value label
    const labelX = d.pct_change >= 0 ? zero + barW + 4 : zero - barW - 4;
    const anchor = d.pct_change >= 0 ? "start" : "end";
    g.append("text").attr("class", "bar-value")
      .attr("x", labelX).attr("y", y + ROW / 2 + 4)
      .attr("text-anchor", anchor)
      .text(`${d.pct_change >= 0 ? "+" : ""}${d.pct_change.toFixed(1)}%`);
  });

  // X axis
  g.append("g").attr("class", "axis").attr("transform", `translate(0,${data.length * ROW})`)
    .call(d3.axisBottom(x).ticks(5).tickFormat(v => (v >= 0 ? "+" : "") + v.toFixed(0) + "%"));
}

// ── Dependency Race ───────────────────────────────────────────────────────────
async function refreshRace() {
  const raw = await fetch(`/api/race/${state.commodity}`).then(r => r.json());
  state.raceData = raw;

  const years = [...new Set(raw.map(d => d.year))].sort();
  state.raceYears = years;
  state.raceYearIdx = 0;

  const raceSlider = document.getElementById("race-slider");
  raceSlider.min = years[0];
  raceSlider.max = years[years.length - 1];
  raceSlider.value = years[0];
  raceSlider.addEventListener("input", () => {
    const yr = +raceSlider.value;
    const idx = years.indexOf(yr);
    if (idx >= 0) { state.raceYearIdx = idx; drawRaceFrame(yr); }
  });

  document.getElementById("race-play-btn").onclick = startRace;
  document.getElementById("race-pause-btn").onclick = pauseRace;

  drawRaceFrame(years[0]);
}

function drawRaceFrame(year) {
  document.getElementById("race-year-label").textContent = year;
  document.getElementById("race-slider").value = year;

  const TOP_N = 15;
  const yearData = state.raceData.filter(d => d.year === year)
    .sort((a, b) => b.top1_share - a.top1_share).slice(0, TOP_N)
    .sort((a, b) => a.top1_share - b.top1_share);

  const section = document.getElementById("race-section");
  const W = section.clientWidth - 64 || 700;
  const ROW = 28;
  const PAD_LEFT = 160, PAD_RIGHT = 60;
  const H = TOP_N * ROW + 60;
  const iW = W - PAD_LEFT - PAD_RIGHT;

  const svg = d3.select("#race-chart").attr("height", H).attr("viewBox", `0 0 ${W} ${H}`);
  svg.selectAll("*").remove();

  if (!yearData.length) return;

  const g = svg.append("g").attr("transform", `translate(${PAD_LEFT},20)`);
  const x = d3.scaleLinear().domain([0, 100]).range([0, iW]);

  // Zone backgrounds
  [[0, 33, "rgba(34,197,94,0.07)"], [33, 66, "rgba(234,179,8,0.07)"], [66, 100, "rgba(239,68,68,0.07)"]].forEach(([x0, x1, fill]) => {
    g.append("rect").attr("x", x(x0)).attr("y", 0).attr("width", x(x1) - x(x0))
      .attr("height", yearData.length * ROW).attr("fill", fill);
  });

  yearData.forEach((d, i) => {
    const y = i * ROW + 2;
    const color = d.top1_share >= 66 ? "var(--red)" : d.top1_share >= 33 ? "var(--yellow)" : "var(--green)";

    g.append("rect").attr("x", 0).attr("y", y + 2)
      .attr("width", x(d.top1_share)).attr("height", ROW - 6)
      .attr("fill", color).attr("rx", 2).attr("opacity", 0.85)
      .append("title")
      .text(`${d.reporter}\nTop partner: ${d.top1_partner}\n${d.top1_share.toFixed(1)}%`);

    svg.append("text").attr("class", "bar-label")
      .attr("x", PAD_LEFT - 6).attr("y", y + ROW / 2 + 4 + 20)
      .attr("text-anchor", "end")
      .text(d.reporter.length > 20 ? d.reporter.slice(0, 18) + "…" : d.reporter);

    g.append("text").attr("class", "bar-value")
      .attr("x", x(d.top1_share) + 4).attr("y", y + ROW / 2 + 4)
      .text(`${d.top1_share.toFixed(1)}% (${d.top1_partner.length > 12 ? d.top1_partner.slice(0, 10) + "…" : d.top1_partner})`);
  });

  g.append("g").attr("class", "axis").attr("transform", `translate(0,${yearData.length * ROW})`)
    .call(d3.axisBottom(x).ticks(5).tickFormat(v => v + "%"));
}

function startRace() {
  document.getElementById("race-play-btn").style.display = "none";
  document.getElementById("race-pause-btn").style.display = "";
  animateRace();
}

function pauseRace() {
  if (state.raceTimer) { clearTimeout(state.raceTimer); state.raceTimer = null; }
  document.getElementById("race-play-btn").style.display = "";
  document.getElementById("race-pause-btn").style.display = "none";
}

function animateRace() {
  if (state.raceYearIdx >= state.raceYears.length) {
    state.raceYearIdx = 0;
    pauseRace();
    return;
  }
  drawRaceFrame(state.raceYears[state.raceYearIdx]);
  state.raceYearIdx++;
  state.raceTimer = setTimeout(animateRace, 700);
}

// ── Compare select population ─────────────────────────────────────────────────
function buildCompareSelect(meta) {
  // Will be populated after first map data load — we need country names
  // We pull them from the first available commodity summary
  fetch(`/api/map/${meta.available[0]}/2023/total`).then(r => r.json()).then(data => {
    const sel = document.getElementById("compare-select");
    const sorted = [...data].sort((a, b) => a.reporter.localeCompare(b.reporter));
    sorted.forEach(d => {
      const opt = document.createElement("option");
      opt.value = d.reporter_iso3;
      opt.textContent = d.reporter;
      sel.appendChild(opt);
    });
  });
}

// ── Numeric country ID → ISO3 lookup ─────────────────────────────────────────
// The 110m topojson uses ISO 3166-1 numeric codes. We map them to alpha-3.
// This is a compact subset covering all UN Comtrade reporters.
const NUMERIC_TO_ISO3 = {4:"AFG",8:"ALB",10:"ATA",12:"DZA",16:"ASM",20:"AND",24:"AGO",28:"ATG",31:"AZE",32:"ARG",36:"AUS",40:"AUT",44:"BHS",48:"BHR",50:"BGD",51:"ARM",52:"BRB",56:"BEL",60:"BMU",64:"BTN",68:"BOL",70:"BIH",72:"BWA",74:"BVT",76:"BRA",84:"BLZ",86:"IOT",90:"SLB",92:"VGB",96:"BRN",100:"BGR",104:"MMR",108:"BDI",112:"BLR",116:"KHM",120:"CMR",124:"CAN",132:"CPV",136:"CYM",140:"CAF",144:"LKA",148:"TCD",152:"CHL",156:"CHN",158:"TWN",162:"CXR",166:"CCK",170:"COL",174:"COM",175:"MYT",178:"COG",180:"COD",184:"COK",188:"CRI",191:"HRV",192:"CUB",196:"CYP",203:"CZE",204:"BEN",208:"DNK",212:"DMA",214:"DOM",218:"ECU",222:"SLV",226:"GNQ",231:"ETH",232:"ERI",233:"EST",234:"FRO",238:"FLK",239:"SGS",242:"FJI",246:"FIN",248:"ALA",250:"FRA",254:"GUF",258:"PYF",260:"ATF",262:"DJI",266:"GAB",268:"GEO",270:"GMB",275:"PSE",276:"DEU",288:"GHA",292:"GIB",296:"KIR",300:"GRC",304:"GRL",308:"GRD",312:"GLP",316:"GUM",320:"GTM",324:"GIN",328:"GUY",332:"HTI",334:"HMD",336:"VAT",340:"HND",344:"HKG",348:"HUN",352:"ISL",356:"IND",360:"IDN",364:"IRN",368:"IRQ",372:"IRL",376:"ISR",380:"ITA",384:"CIV",388:"JAM",392:"JPN",398:"KAZ",400:"JOR",404:"KEN",408:"PRK",410:"KOR",414:"KWT",417:"KGZ",418:"LAO",422:"LBN",426:"LSO",428:"LVA",430:"LBR",434:"LBY",438:"LIE",440:"LTU",442:"LUX",446:"MAC",450:"MDG",454:"MWI",458:"MYS",462:"MDV",466:"MLI",470:"MLT",474:"MTQ",478:"MRT",480:"MUS",484:"MEX",492:"MCO",496:"MNG",498:"MDA",499:"MNE",500:"MSR",504:"MAR",508:"MOZ",512:"OMN",516:"NAM",520:"NRU",524:"NPL",528:"NLD",531:"CUW",533:"ABW",534:"SXM",535:"BES",540:"NCL",548:"VUT",554:"NZL",558:"NIC",562:"NER",566:"NGA",570:"NIU",574:"NFK",578:"NOR",580:"MNP",581:"UMI",583:"FSM",584:"MHL",585:"PLW",586:"PAK",591:"PAN",598:"PNG",600:"PRY",604:"PER",608:"PHL",612:"PCN",616:"POL",620:"PRT",624:"GNB",626:"TLS",630:"PRI",634:"QAT",638:"REU",642:"ROU",643:"RUS",646:"RWA",652:"BLM",654:"SHN",659:"KNA",660:"AIA",662:"LCA",663:"MAF",666:"SPM",670:"VCT",674:"SMR",678:"STP",682:"SAU",686:"SEN",688:"SRB",690:"SYC",694:"SLE",702:"SGP",703:"SVK",704:"VNM",705:"SVN",706:"SOM",710:"ZAF",716:"ZWE",724:"ESP",728:"SSD",729:"SDN",732:"ESH",740:"SUR",744:"SJM",748:"SWZ",752:"SWE",756:"CHE",760:"SYR",762:"TJK",764:"THA",768:"TGO",772:"TKL",776:"TON",780:"TTO",784:"ARE",788:"TUN",792:"TUR",795:"TKM",796:"TCA",798:"TUV",800:"UGA",804:"UKR",807:"MKD",818:"EGY",826:"GBR",831:"GGY",832:"JEY",833:"IMN",834:"TZA",840:"USA",850:"VIR",854:"BFA",858:"URY",860:"UZB",862:"VEN",876:"WLF",882:"WSM",887:"YEM",894:"ZMB"};

function numericToIso3(id) {
  return NUMERIC_TO_ISO3[+id] || null;
}

// ── Utility ───────────────────────────────────────────────────────────────────
function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// ── Start ─────────────────────────────────────────────────────────────────────
init();
