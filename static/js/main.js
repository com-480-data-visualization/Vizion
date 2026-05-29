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
  tradersFlow: "total",
  meta: null,
  raceData: null,
  raceTimer: null,
  raceYearIdx: 0,
  commodityColor: "#3b82f6",
  disruptionPartner: null, // non-null = disruption mode active
  disruptionType: "exporter", // "exporter" or "importer"
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
  await refreshTopTraders();
  await refreshRace();
  await initBlocs(meta);
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
  await refreshTopTraders();
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
    refreshTopTraders();
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

  // Traders flow toggle
  document.getElementById("traders-flow-toggle").addEventListener("click", e => {
    const pill = e.target.closest(".radio-pill");
    if (!pill) return;
    document.querySelectorAll("#traders-flow-toggle .radio-pill").forEach(p => p.classList.remove("active"));
    pill.classList.add("active");
    state.tradersFlow = pill.dataset.value;
    refreshTopTraders();
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
  const endpoint = state.disruptionType === "importer"
    ? `/api/disruption_import/${state.commodity}/${encodeURIComponent(partner)}/${state.year}`
    : `/api/disruption/${state.commodity}/${encodeURIComponent(partner)}/${state.year}`;
  const data = await fetch(endpoint).then(r => r.json());

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
  const cbLabel = state.disruptionType === "importer"
    ? `% exports to ${partner}` : `% imports from ${partner}`;
  renderColorbar(d3.select("#world-map"), colorScale, 100, W, 480, cbLabel);
}

async function activateDisruption(partner, type) {
  state.disruptionPartner = partner;
  state.disruptionType    = type; // "exporter" or "importer"
  const commLabel = state.meta.commodities[state.commodity].label;
  const label = type === "exporter"
    ? `⚡ ${partner} removed as ${commLabel} supplier: who loses their source?`
    : `⚡ ${partner} stops importing ${commLabel}: who loses their buyer?`;
  document.getElementById("disruption-banner-text").textContent = label;
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

  const countryName = panel.name || state.selectedIso3;
  const commLabel   = state.meta.commodities[state.commodity].label;

  el.innerHTML = `
    <div style="padding:16px 0 8px;">
      <p style="font-size:13px;color:var(--muted);margin-bottom:14px;">
        Simulate removing <strong style="color:${state.commodityColor}">${countryName}</strong>
        from global ${commLabel} trade. The map will show which countries are most exposed.
      </p>
      <div class="radio-group" id="disruption-type-toggle" style="margin-bottom:14px;">
        <label class="radio-pill active" data-value="exporter">As exporter (supply shock)</label>
        <label class="radio-pill" data-value="importer">As importer (demand shock)</label>
      </div>
      <button id="disruption-map-btn" class="play-btn" style="font-size:14px;padding:8px 20px;">
        &#9889; Simulate removing ${countryName}
      </button>
    </div>
    <div id="disruption-results" style="margin-top:12px;"></div>
  `;

  // Toggle logic
  el.querySelector("#disruption-type-toggle").addEventListener("click", e => {
    const pill = e.target.closest(".radio-pill");
    if (!pill) return;
    el.querySelectorAll("#disruption-type-toggle .radio-pill").forEach(p => p.classList.remove("active"));
    pill.classList.add("active");
  });

  el.querySelector("#disruption-map-btn").addEventListener("click", () => {
    const type = el.querySelector("#disruption-type-toggle .radio-pill.active").dataset.value;
    activateDisruption(countryName, type);
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
  const nameB = statB?.name || iso3B || "n/a";

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

// ── Top Traders ───────────────────────────────────────────────────────────────
async function refreshTopTraders() {
  const flow = state.tradersFlow;
  const data = await fetch(
    `/api/map/${state.commodity}/${state.year}/${flow}`
  ).then(r => r.json());

  const sorted = data.filter(d => d.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, 15);

  const subtitle = `${state.year}  ·  ${state.meta.commodities[state.commodity].label}`;
  document.getElementById("traders-subtitle").textContent = subtitle;

  const section = document.getElementById("traders-section");
  const W = section.clientWidth - 64 || 700;
  const ROW = 26;
  const PAD_LEFT = 160, PAD_RIGHT = 80;
  const H = sorted.length * ROW + 60;
  const iW = W - PAD_LEFT - PAD_RIGHT;

  const svg = d3.select("#traders-chart").attr("height", H).attr("viewBox", `0 0 ${W} ${H}`);
  svg.selectAll("*").remove();

  if (!sorted.length) {
    svg.append("text").attr("x", 20).attr("y", 40).attr("fill", "var(--muted)").text("No data");
    return;
  }

  const color = flow === "Import" ? "var(--imp)" : flow === "Export" ? "var(--exp)" : "var(--cyan)";
  const xScale = d3.scaleLinear().domain([0, sorted[0].value]).range([0, iW]);
  const g = svg.append("g").attr("transform", `translate(${PAD_LEFT},20)`);

  sorted.forEach((d, i) => {
    const y = i * ROW + 4;
    const bW = xScale(d.value);

    g.append("rect").attr("x", 0).attr("y", y + 2)
      .attr("width", Math.max(2, bW)).attr("height", ROW - 6)
      .attr("fill", color).attr("rx", 2).attr("opacity", 0.85);

    svg.append("text").attr("class", "bar-label")
      .attr("x", PAD_LEFT - 6).attr("y", y + ROW / 2 + 4 + 20)
      .attr("text-anchor", "end")
      .text(d.reporter.length > 20 ? d.reporter.slice(0, 18) + "…" : d.reporter);

    g.append("text").attr("class", "bar-value")
      .attr("x", bW + 4).attr("y", y + ROW / 2 + 4)
      .attr("text-anchor", "start")
      .text(fmtUSD(d.value));
  });

  g.append("g").attr("class", "axis").attr("transform", `translate(0,${sorted.length * ROW})`)
    .call(d3.axisBottom(xScale).ticks(4).tickFormat(fmtUSD));
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

// ── Trade Blocs ───────────────────────────────────────────────────────────────
const blocsState = {
  isoA: "DEU", isoB: "JPN",
  threshold: 10, year: 2021,
  commodity: "vehicles",
  data: null, nameA: "Germany", nameB: "Japan",
};

function getBlocColor(sA, sB, thr) {
  const a = sA >= thr, b = sB >= thr;
  if (a && b) return "#eab308";
  if (a)      return "#3b82f6";
  if (b)      return "#ef4444";
  return "#475569";
}

async function initBlocs(meta) {
  const commSel = document.getElementById("bloc-comm-select");
  meta.available.forEach(c => {
    const opt = document.createElement("option");
    opt.value = c;
    opt.textContent = meta.commodities[c].label;
    if (c === "vehicles") opt.selected = true;
    commSel.appendChild(opt);
  });

  const sorted = [...meta.countries].sort((a, b) => a.name.localeCompare(b.name));
  ["bloc-a-select", "bloc-b-select"].forEach((id, idx) => {
    const sel = document.getElementById(id);
    sorted.forEach(c => {
      const opt = document.createElement("option");
      opt.value = c.iso3;
      opt.textContent = c.name;
      if (c.iso3 === (idx === 0 ? "DEU" : "JPN")) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.addEventListener("change", e => {
      if (idx === 0) blocsState.isoA = e.target.value;
      else           blocsState.isoB = e.target.value;
      refreshBlocs();
    });
  });

  commSel.addEventListener("change", e => { blocsState.commodity = e.target.value; refreshBlocs(); });

  document.getElementById("blocs-threshold").addEventListener("input", e => {
    blocsState.threshold = +e.target.value;
    document.getElementById("blocs-threshold-display").textContent = blocsState.threshold;
    if (blocsState.data) { drawBlocsMap(blocsState.data); drawBlocsScatter(blocsState.data); drawGravity(blocsState.data); }
  });

  document.getElementById("blocs-year-slider").addEventListener("input", e => {
    blocsState.year = +e.target.value;
    document.getElementById("blocs-year-display").textContent = blocsState.year;
    refreshBlocs();
  });

  document.getElementById("gravity-year-slider").addEventListener("input", e => {
    blocsState.year = +e.target.value;
    document.getElementById("gravity-year-display").textContent = blocsState.year;
    document.getElementById("blocs-year-slider").value = blocsState.year;
    document.getElementById("blocs-year-display").textContent = blocsState.year;
    refreshBlocs();
  });
  document.getElementById("gravity-threshold").addEventListener("input", e => {
    blocsState.threshold = +e.target.value;
    document.getElementById("gravity-threshold-display").textContent = blocsState.threshold;
    document.getElementById("blocs-threshold").value = blocsState.threshold;
    document.getElementById("blocs-threshold-display").textContent = blocsState.threshold;
    if (blocsState.data) { drawBlocsMap(blocsState.data); drawBlocsScatter(blocsState.data); drawGravity(blocsState.data); }
  });

  initBlocsMapSvg();
  await refreshBlocs();
}

function initBlocsMapSvg() {
  const container = document.getElementById("blocs-map-container");
  const W = container.getBoundingClientRect().width || 600;
  const scale = W / 6.3;
  const H = Math.min(Math.round(scale * 3.3), 480);

  const svg = d3.select("#blocs-map").attr("width", W).attr("height", H);

  const proj = d3.geoNaturalEarth1().scale(scale).translate([W / 2, H / 2]);
  const p    = d3.geoPath().projection(proj);

  blocsState.proj = proj;
  blocsState.path = p;
  blocsState.mapW = W;
  blocsState.mapH = H;

  const g = svg.append("g").attr("id", "blocs-map-group");
  g.append("path").datum(d3.geoGraticule()()).attr("class", "graticule").attr("d", p);

  if (worldGeo) {
    const features = topojson.feature(worldGeo, worldGeo.objects.countries).features;
    g.append("g").attr("id", "blocs-countries-group")
      .selectAll("path")
      .data(features)
      .join("path")
      .attr("d", p)
      .attr("fill", "#334155")
      .attr("stroke", "#475569")
      .attr("stroke-width", "0.4px")
      .attr("visibility", d => numericToIso3(d.id) ? null : "hidden");
  }
}

async function refreshBlocs() {
  const { isoA, isoB, year, commodity } = blocsState;
  const [data, pA, pB] = await Promise.all([
    fetch(`/api/bloc/${commodity}/${isoA}/${isoB}/${year}`).then(r => r.json()),
    fetch(`/api/country/${commodity}/${isoA}/${year}`).then(r => r.json()),
    fetch(`/api/country/${commodity}/${isoB}/${year}`).then(r => r.json()),
  ]);
  blocsState.data  = data;
  blocsState.nameA = pA.name || isoA;
  blocsState.nameB = pB.name || isoB;
  drawBlocsMap(data);
  drawBlocsScatter(data);
  drawGravity(data);
  updateBlocsLegend();
}

function drawBlocsMap(data) {
  const { threshold, isoA, isoB, nameA, nameB } = blocsState;
  const tip = document.getElementById("shared-tooltip");

  const shareMap = {};
  data.forEach(d => { shareMap[d.iso3] = d; });
  shareMap[isoA] = { iso3: isoA, name: nameA, share_a: 100, share_b: 0 };
  shareMap[isoB] = { iso3: isoB, name: nameB, share_a: 0,   share_b: 100 };

  d3.select("#blocs-countries-group").selectAll("path")
    .attr("fill", d => {
      const iso3 = numericToIso3(d.id);
      const e = iso3 && shareMap[iso3];
      return e ? getBlocColor(e.share_a, e.share_b, threshold) : "#334155";
    })
    .style("cursor", "default")
    .on("mouseover", (event, d) => {
      const iso3 = numericToIso3(d.id);
      const e = iso3 && shareMap[iso3];
      if (!e) return;
      const isAnchorA = iso3 === isoA, isAnchorB = iso3 === isoB;
      tip.innerHTML = isAnchorA
        ? `<strong>${nameA}</strong><br>Bloc A anchor`
        : isAnchorB
        ? `<strong>${nameB}</strong><br>Bloc B anchor`
        : `<strong>${e.name}</strong><br>${nameA}: ${e.share_a.toFixed(1)}%&nbsp;&nbsp;${nameB}: ${e.share_b.toFixed(1)}%`;
      tip.classList.add("visible");
    })
    .on("mousemove", event => {
      tip.style.left = (event.clientX + 12) + "px";
      tip.style.top  = (event.clientY - 10) + "px";
    })
    .on("mouseout", () => tip.classList.remove("visible"));
}

function drawBlocsScatter(data) {
  const { threshold, nameA, nameB } = blocsState;
  const container = document.getElementById("blocs-scatter-container");
  const W = container.getBoundingClientRect().width || 360;
  const H = blocsState.mapH || 380;
  const m = { top: 24, right: 16, bottom: 52, left: 52 };
  const iW = W - m.left - m.right;
  const iH = H - m.top  - m.bottom;

  const svg = d3.select("#blocs-scatter").attr("width", W).attr("height", H);
  svg.selectAll("*").remove();
  const g = svg.append("g").attr("transform", `translate(${m.left},${m.top})`);

  const maxA = d3.max(data, d => d.share_a) || 10;
  const maxB = d3.max(data, d => d.share_b) || 10;
  const axMax = Math.min(Math.ceil(Math.max(maxA, maxB, threshold + 5) / 5) * 5 + 5, 100);

  const xSc = d3.scaleLinear().domain([0, axMax]).range([0, iW]);
  const ySc = d3.scaleLinear().domain([0, axMax]).range([iH, 0]);
  const tX  = xSc(threshold);
  const tY  = ySc(threshold);

  g.append("rect").attr("x", tX).attr("y", 0)
    .attr("width", iW - tX).attr("height", tY)
    .attr("fill", "#3b82f6").attr("opacity", 0.07);
  g.append("rect").attr("x", 0).attr("y", tY)
    .attr("width", tX).attr("height", iH - tY)
    .attr("fill", "#ef4444").attr("opacity", 0.07);
  g.append("rect").attr("x", tX).attr("y", tY)
    .attr("width", iW - tX).attr("height", iH - tY)
    .attr("fill", "#eab308").attr("opacity", 0.09);

  g.append("line").attr("x1", tX).attr("x2", tX).attr("y1", 0).attr("y2", iH)
    .attr("stroke", "#3b82f6").attr("stroke-dasharray", "4,3").attr("opacity", 0.5);
  g.append("line").attr("x1", 0).attr("x2", iW).attr("y1", tY).attr("y2", tY)
    .attr("stroke", "#ef4444").attr("stroke-dasharray", "4,3").attr("opacity", 0.5);

  g.append("text").attr("x", (tX + iW) / 2).attr("y", iH - 4)
    .attr("text-anchor", "middle").attr("font-size", 9).attr("fill", "#3b82f6").attr("opacity", 0.7)
    .text(`${nameA} camp`);
  g.append("text").attr("x", tX / 2).attr("y", (tY + iH) / 2)
    .attr("text-anchor", "middle").attr("font-size", 9).attr("fill", "#ef4444").attr("opacity", 0.7)
    .text(`${nameB} camp`);
  g.append("text").attr("x", (tX + iW) / 2).attr("y", tY - 4)
    .attr("text-anchor", "middle").attr("font-size", 9).attr("fill", "#eab308").attr("opacity", 0.7)
    .text("Swing");

  g.append("g").attr("class", "axis").attr("transform", `translate(0,${iH})`)
    .call(d3.axisBottom(xSc).ticks(5).tickFormat(d => d + "%"));
  g.append("g").attr("class", "axis")
    .call(d3.axisLeft(ySc).ticks(5).tickFormat(d => d + "%"));

  g.append("text").attr("x", iW / 2).attr("y", iH + 44)
    .attr("text-anchor", "middle").attr("fill", "#94a3b8").attr("font-size", 10)
    .text(`% from ${nameA}`);
  g.append("text").attr("transform", "rotate(-90)")
    .attr("x", -iH / 2).attr("y", -40)
    .attr("text-anchor", "middle").attr("fill", "#94a3b8").attr("font-size", 10)
    .text(`% from ${nameB}`);

  const tip = document.getElementById("shared-tooltip");

  g.selectAll(".bloc-dot")
    .data(data)
    .join("circle")
    .attr("class", "bloc-dot")
    .attr("cx", d => xSc(d.share_a))
    .attr("cy", d => ySc(d.share_b))
    .attr("r", 4)
    .attr("fill", d => getBlocColor(d.share_a, d.share_b, threshold))
    .attr("opacity", 0.85)
    .attr("stroke", "#0f172a").attr("stroke-width", 0.5)
    .on("mouseover", (event, d) => {
      d3.select(event.currentTarget).attr("r", 6).attr("stroke-width", 1.5);
      tip.innerHTML = `<strong>${d.name}</strong><br>${nameA}: ${d.share_a.toFixed(1)}%<br>${nameB}: ${d.share_b.toFixed(1)}%`;
      tip.classList.add("visible");
    })
    .on("mousemove", event => {
      tip.style.left = (event.clientX + 12) + "px";
      tip.style.top  = (event.clientY - 10) + "px";
    })
    .on("mouseout", event => {
      d3.select(event.currentTarget).attr("r", 4).attr("stroke-width", 0.5);
      tip.classList.remove("visible");
    });

  const swing = data.filter(d => d.share_a >= threshold && d.share_b >= threshold);
  g.selectAll(".bloc-label")
    .data(swing)
    .join("text").attr("class", "bloc-label")
    .attr("x", d => xSc(d.share_a) + 6)
    .attr("y", d => ySc(d.share_b) + 4)
    .attr("font-size", 9).attr("fill", "#e2e8f0")
    .text(d => d.name.length > 14 ? d.iso3 : d.name);
}

const GRAVITY_MAJOR = new Set([
  "USA","CHN","FRA","GBR","IND","BRA","CAN","AUS","RUS","KOR",
  "ITA","ESP","MEX","IDN","SAU","TUR","ZAF","NGA","NLD","BEL",
  "CHE","SWE","POL","ARG","THA","MYS","SGP","EGY","IRN","NOR",
]);

function drawGravity(data) {
  const { nameA, nameB, threshold } = blocsState;
  const section = document.getElementById("gravity-section");
  const W = section.getBoundingClientRect().width - 64;
  const H = 460;
  const leftX   = 95;
  const rightX  = W - 95;
  const centerX = (leftX + rightX) / 2;
  const halfW   = (rightX - leftX) / 2;
  const centerY = H / 2;

  const svg = d3.select("#gravity-chart").attr("width", W).attr("height", H);
  svg.selectAll("*").remove();

  svg.append("rect").attr("x", 0).attr("y", 0).attr("width", centerX).attr("height", H)
    .attr("fill", "#3b82f6").attr("opacity", 0.03);
  svg.append("rect").attr("x", centerX).attr("y", 0).attr("width", W - centerX).attr("height", H)
    .attr("fill", "#ef4444").attr("opacity", 0.03);

  svg.append("line")
    .attr("x1", centerX).attr("x2", centerX).attr("y1", 24).attr("y2", H - 12)
    .attr("stroke", "#334155").attr("stroke-dasharray", "5,4").attr("stroke-width", 1);

  svg.append("text").attr("x", (leftX + centerX) / 2).attr("y", 16)
    .attr("text-anchor", "middle").attr("font-size", 11).attr("fill", "#3b82f6").attr("opacity", 0.6)
    .text(`${nameA}'s zone`);
  svg.append("text").attr("x", (rightX + centerX) / 2).attr("y", 16)
    .attr("text-anchor", "middle").attr("font-size", 11).attr("fill", "#ef4444").attr("opacity", 0.6)
    .text(`${nameB}'s zone`);
  svg.append("text").attr("x", centerX).attr("y", 16)
    .attr("text-anchor", "middle").attr("font-size", 10).attr("fill", "#94a3b8")
    .text("◀ contested ▶");

  [{ x: leftX, name: nameA, color: "#3b82f6" },
   { x: rightX, name: nameB, color: "#ef4444" }].forEach(pole => {
    svg.append("circle").attr("cx", pole.x).attr("cy", centerY)
      .attr("r", 36).attr("fill", pole.color).attr("opacity", 0.9);
    pole.name.split(" ").forEach((w, i, arr) => {
      svg.append("text")
        .attr("x", pole.x).attr("y", centerY + (i - (arr.length - 1) / 2) * 13 + 1)
        .attr("text-anchor", "middle").attr("fill", "#fff")
        .attr("font-size", 10).attr("font-weight", 700).attr("pointer-events", "none")
        .text(w);
    });
  });

  const maxImp = d3.max(data, d => d.total_imp) || 1;
  const rScale = d3.scaleSqrt().domain([0, maxImp]).range([3, 18]);

  const active = data.filter(d => d.share_a >= threshold || d.share_b >= threshold);
  const neutralCount = data.length - active.length;

  svg.append("text").attr("x", centerX).attr("y", H - 8)
    .attr("text-anchor", "middle").attr("font-size", 10).attr("fill", "#475569")
    .text(`${neutralCount} neutral countries (below ${threshold}% threshold) not shown`);

  const nodes = active.map(d => {
    const total   = d.share_a + d.share_b;
    const ratio   = total > 0 ? (d.share_b - d.share_a) / total : 0;
    const targetX = centerX + ratio * halfW * 0.82;
    const r       = rScale(d.total_imp || 0);
    return { ...d, x: targetX + (Math.random() - 0.5) * 40,
             y: centerY + (Math.random() - 0.5) * (H * 0.55), targetX, r };
  });

  const tip = document.getElementById("shared-tooltip");
  const nodeG = svg.append("g");

  const circles = nodeG.selectAll("circle.gnode")
    .data(nodes).join("circle").attr("class", "gnode")
    .attr("r", d => d.r)
    .attr("fill", d => getBlocColor(d.share_a, d.share_b, threshold))
    .attr("stroke", "#0f172a").attr("stroke-width", 0.5).attr("opacity", 0.88)
    .on("mouseover", (event, d) => {
      d3.select(event.currentTarget).attr("stroke", "#fff").attr("stroke-width", 2);
      tip.innerHTML = `<strong>${d.name}</strong><br>${nameA}: ${d.share_a.toFixed(1)}%<br>${nameB}: ${d.share_b.toFixed(1)}%`;
      tip.classList.add("visible");
    })
    .on("mousemove", event => {
      tip.style.left = (event.clientX + 12) + "px";
      tip.style.top  = (event.clientY - 10) + "px";
    })
    .on("mouseout", event => {
      d3.select(event.currentTarget).attr("stroke", "#0f172a").attr("stroke-width", 0.5);
      tip.classList.remove("visible");
    });

  const labeledNodes = nodes.filter(d =>
    GRAVITY_MAJOR.has(d.iso3) || (d.share_a >= threshold && d.share_b >= threshold)
  );
  const labels = nodeG.selectAll("text.glabel")
    .data(labeledNodes).join("text").attr("class", "glabel")
    .attr("text-anchor", "middle")
    .attr("font-size", d => GRAVITY_MAJOR.has(d.iso3) ? 9 : 8)
    .attr("font-weight", d => GRAVITY_MAJOR.has(d.iso3) ? 600 : 400)
    .attr("fill", "#e2e8f0").attr("pointer-events", "none")
    .text(d => d.iso3);

  const poles = [{ x: leftX, y: centerY }, { x: rightX, y: centerY }];
  const poleR  = 36 + 6; // pole radius + padding

  function repelPoles() {
    for (const node of nodes) {
      for (const pole of poles) {
        const dx = node.x - pole.x;
        const dy = node.y - pole.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const minDist = poleR + node.r;
        if (dist < minDist) {
          const push = (minDist - dist) / dist * 0.8;
          node.x += dx * push;
          node.y += dy * push;
        }
      }
    }
  }

  const sim = d3.forceSimulation(nodes)
    .force("x", d3.forceX(d => d.targetX).strength(0.38))
    .force("y", d3.forceY(centerY).strength(0.04))
    .force("collision", d3.forceCollide(d => d.r + 2).strength(0.9))
    .force("poles", repelPoles)
    .force("charge", d3.forceManyBody().strength(-4))
    .on("tick", () => {
      circles.attr("cx", d => d.x).attr("cy", d => d.y);
      labels.attr("x", d => d.x).attr("y", d => d.y + d.r + 9);
    });

  setTimeout(() => sim.stop(), 3500);
}

function updateBlocsLegend() {
  const { nameA, nameB } = blocsState;
  document.getElementById("blocs-legend").innerHTML = `
    <div class="legend-item"><span class="legend-swatch" style="background:#3b82f6"></span>${nameA}'s camp</div>
    <div class="legend-item"><span class="legend-swatch" style="background:#ef4444"></span>${nameB}'s camp</div>
    <div class="legend-item"><span class="legend-swatch" style="background:#eab308"></span>Swing (depends on both)</div>
    <div class="legend-item"><span class="legend-swatch" style="background:#475569"></span>Neutral</div>
  `;
}

// ── Takeaway strip (always-on storytelling layer) ─────────────────────────────
async function renderTakeaways() {
  const strip = document.getElementById("takeaway-strip");
  if (!strip || !state.commodity || !state.year) return;

  let data;
  try {
    data = await fetch(`/api/takeaway/${state.commodity}/${state.year}`).then(r => r.json());
  } catch (err) {
    strip.innerHTML = "";
    return;
  }
  if (!data || !data.largest_importer) { strip.innerHTML = ""; return; }

  const commLabel = state.meta.commodities[state.commodity].label.toLowerCase();
  const li = data.largest_importer || {};
  const le = data.largest_exporter || {};
  const me = data.most_exposed     || {};

  strip.innerHTML = `
    <div class="takeaway-card">
      <div class="takeaway-label">Largest importer</div>
      <div class="takeaway-title">${li.name || "n/a"}</div>
      <div class="takeaway-sub">${li.value ? fmtUSD(li.value) + " of " + commLabel : "no data"}</div>
    </div>
    <div class="takeaway-card exp">
      <div class="takeaway-label">Largest exporter</div>
      <div class="takeaway-title">${le.name || "n/a"}</div>
      <div class="takeaway-sub">${le.value ? fmtUSD(le.value) + " of " + commLabel : "no data"}</div>
    </div>
    <div class="takeaway-card warn">
      <div class="takeaway-label">Highest exposure</div>
      <div class="takeaway-title">${me.country || "n/a"}</div>
      <div class="takeaway-sub">${me.partner ? `${me.partner} supplies ${me.share}%` : "no concentration signal"}</div>
    </div>
    <div class="takeaway-card guide">
      <div class="takeaway-label">How to read this</div>
      <div class="takeaway-title">Scale &ne; exposure</div>
      <div class="takeaway-sub">Click any country to dig in.</div>
    </div>`;
}

// Wire the strip into existing refresh paths (without touching the originals)
const _origRefreshAll = refreshAll;
refreshAll = async function () {
  await _origRefreshAll();
  await renderTakeaways();
};
(function attachYearStrip() {
  const slider = document.getElementById("year-slider");
  if (slider) slider.addEventListener("input", () => renderTakeaways());
})();
// Defensive: re-render on commodity-pill clicks (delegated, bubbles after the
// per-pill handler runs, so state.commodity is already updated)
(function attachCommodityStrip() {
  const nav = document.getElementById("commodity-nav");
  if (!nav) return;
  nav.addEventListener("click", e => {
    if (e.target.closest(".comm-pill")) {
      // microtask delay so selectCommodity finishes first
      Promise.resolve().then(renderTakeaways);
    }
  });
})();
// Initial render after init() finishes (re-poll briefly until commodity loaded)
(function initialStripRender() {
  const tick = () => {
    if (state.commodity && state.meta) { renderTakeaways(); return; }
    setTimeout(tick, 200);
  };
  tick();
})();

// ── Guided tour ──────────────────────────────────────────────────────────────
const tourState = { active: false, step: 0 };

function switchTabTo(name) {
  document.querySelectorAll(".tab-btn").forEach(b => b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll(".tab-content").forEach(c => c.classList.toggle("active", c.id === "tab-" + name));
  refreshActiveTab();
}

function setYear(y) {
  const slider = document.getElementById("year-slider");
  if (!slider) return;
  slider.value = y;
  slider.dispatchEvent(new Event("input"));
}

async function selectCountryByIso3(iso3) {
  state.selectedIso3 = iso3;
  d3.select("#countries-group").selectAll("path")
    .classed("selected", dd => numericToIso3(dd.id) === iso3);
  document.getElementById("analysis-section").style.display = "block";
  await refreshSidePanel();
  refreshActiveTab();
}

const TOUR_STEPS = [
  {
    caption: "We're looking at global <strong>vehicle</strong> trade in 2023. Every country is colored by how much it trades. Behind these numbers is a question: what happens when the world stops being neutral?",
    action: async () => {
      selectCommodity("vehicles");
      setYear(2023);
      // Make sure the flow toggle is on Total
      document.querySelectorAll("#flow-toggle .radio-pill").forEach(p =>
        p.classList.toggle("active", p.dataset.value === "total"));
      state.flow = "total";
      await refreshMap();
      window.scrollTo({ top: 0, behavior: "smooth" });
    },
  },
  {
    caption: "Let's start with <strong>Germany</strong>, a major vehicle exporter. You can see exactly where its trade goes: the US, China, the UK. The side panel breaks it down.",
    action: async () => {
      await selectCountryByIso3("DEU");
      switchTabTo("history");
      document.getElementById("main-area").scrollIntoView({ behavior: "smooth", block: "start" });
    },
  },
  {
    caption: "Now look at the <strong>Dependency</strong> tab. Some countries source over 30% of their vehicle supply from a single partner. That's fragile, and it's been getting worse over time.",
    action: async () => {
      switchTabTo("dependency");
      document.getElementById("analysis-section").scrollIntoView({ behavior: "smooth", block: "start" });
    },
  },
  {
    caption: "What if Germany suddenly couldn't export? The map lights up. Every country that depended on it takes a hit. You can switch between <strong>supply shock</strong> and <strong>demand shock</strong>.",
    action: async () => {
      switchTabTo("disruption");
      // Render the disruption tab UI, then activate Germany as removed exporter
      await drawDisruption();
      await activateDisruption("Germany", "exporter");
      document.getElementById("main-area").scrollIntoView({ behavior: "smooth", block: "start" });
    },
  },
  {
    caption: "Germany and Japan together cover most of the world's vehicle exports. If countries had to choose, who lands where? <strong>Blue</strong> is Germany's camp, <strong>red</strong> is Japan's, <strong>yellow</strong> are the swing countries.",
    action: async () => {
      deactivateDisruption();
      document.getElementById("blocs-section").scrollIntoView({ behavior: "smooth", block: "start" });
    },
  },
  {
    caption: "Here's the same data as a <strong>force simulation</strong>. Every country pulled toward one pole or the other, sized by import volume. The closer to the center, the harder the choice.",
    action: async () => {
      document.getElementById("gravity-section").scrollIntoView({ behavior: "smooth", block: "start" });
    },
  },
  {
    caption: "The world isn't divided yet, but the data shows exactly how it could be. Now it's your turn: change the commodity, the year, the anchors. The story is everywhere.",
    action: async () => { /* stay where we are */ },
  },
];

function ensureTourBackdrop() {
  let bd = document.getElementById("tour-backdrop");
  if (!bd) {
    bd = document.createElement("div");
    bd.id = "tour-backdrop";
    bd.className = "tour-backdrop";
    document.body.appendChild(bd);
  }
}

function removeTourElements() {
  document.getElementById("tour-backdrop")?.remove();
  document.getElementById("tour-card")?.remove();
}

async function renderTourStep() {
  const step = TOUR_STEPS[tourState.step];
  if (!step) { exitTour(); return; }

  ensureTourBackdrop();

  // Show a small loading-state for the card while the action runs
  let card = document.getElementById("tour-card");
  if (!card) {
    card = document.createElement("div");
    card.id = "tour-card";
    card.className = "tour-card";
    document.body.appendChild(card);
  }
  const total  = TOUR_STEPS.length;
  const isLast = tourState.step === total - 1;
  const dots = TOUR_STEPS.map((_, i) => {
    if (i < tourState.step)  return '<span class="tour-progress-dot done"></span>';
    if (i === tourState.step) return '<span class="tour-progress-dot current"></span>';
    return '<span class="tour-progress-dot"></span>';
  }).join("");

  card.innerHTML = `
    <div class="tour-step-counter">Step ${tourState.step + 1} of ${total}</div>
    <div class="tour-caption">${step.caption}</div>
    <div class="tour-controls">
      <div class="tour-progress">${dots}</div>
      <div style="display:flex; gap:8px;">
        <button class="tour-btn" id="tour-exit-btn">${isLast ? "Close" : "Skip tour"}</button>
        <button class="tour-btn primary" id="tour-next-btn">${isLast ? "Explore on your own" : "Next →"}</button>
      </div>
    </div>`;

  document.getElementById("tour-next-btn").addEventListener("click", async () => {
    if (isLast) { exitTour(); return; }
    tourState.step++;
    await renderTourStep();
  });
  document.getElementById("tour-exit-btn").addEventListener("click", exitTour);

  // Now actually run the step's side effect
  try { await step.action(); } catch (err) { console.warn("[tour] step action failed:", err); }
}

async function startTour() {
  if (tourState.active) return;
  tourState.active = true;
  tourState.step = 0;
  await renderTourStep();
}

function exitTour() {
  tourState.active = false;
  removeTourElements();
}

(function attachTourButton() {
  const btn = document.getElementById("tour-launcher-btn");
  if (btn) btn.addEventListener("click", startTour);
  // ESC to exit
  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && tourState.active) exitTour();
  });
})();

// ── Start ─────────────────────────────────────────────────────────────────────
init();
