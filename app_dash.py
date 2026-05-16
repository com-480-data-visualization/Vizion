"""
Global Trade Explorer — Multi-Commodity Dashboard (Milestone 2)

Run with:  python app.py
Then open: http://127.0.0.1:8050
"""

from pathlib import Path

import dash
from dash import dcc, html, Input, Output, State, callback, no_update
import plotly.express as px
import plotly.graph_objects as go
import pandas as pd
import numpy as np

# ── Commodity definitions ─────────────────────────────────────────────────────

COMMODITIES = {
    "energy":    {"label": "⚡ Energy",    "hs": "HS 27", "color": "#f97316",
                  "description": "Mineral fuels, oil, gas, coal"},
    "cereals":   {"label": "🌾 Cereals",   "hs": "HS 10", "color": "#22c55e",
                  "description": "Wheat, corn, rice, barley"},
    "steel":     {"label": "🔩 Steel",     "hs": "HS 72", "color": "#94a3b8",
                  "description": "Iron and steel products"},
    "machinery": {"label": "⚙️ Machinery", "hs": "HS 84", "color": "#3b82f6",
                  "description": "Industrial machinery & equipment"},
    "vehicles":  {"label": "🚗 Vehicles",  "hs": "HS 87", "color": "#a855f7",
                  "description": "Cars, trucks, motor vehicles"},
}

AGGREGATE_PARTNERS = {
    "World", "Areas, nes", "Special Categories", "Free Zones",
    "Bunkers", "Other Asia, nes", "Unspecified",
}

# ── Colours & style constants ─────────────────────────────────────────────────

DARK_BG    = "#0f172a"
PANEL_BG   = "#1e293b"
BORDER     = "#334155"
TEXT_MAIN  = "#e2e8f0"
TEXT_MUTED = "#94a3b8"
FONT       = "system-ui, -apple-system, sans-serif"

IMP_COLOR  = "#f97316"   # orange — imports
EXP_COLOR  = "#3b82f6"   # blue   — exports

# ── Data loading ──────────────────────────────────────────────────────────────

DATA_DIR = Path(__file__).parent / "data" / "processed"


def load_commodity(category: str) -> dict | None:
    cs_path = DATA_DIR / f"{category}_country_summary.csv"
    pf_path = DATA_DIR / f"{category}_partner_flow.csv"
    if category == "energy" and not cs_path.exists():
        cs_path = DATA_DIR / "country_summary.csv"
        pf_path = DATA_DIR / "partner_summary.csv"
    if not cs_path.exists() or not pf_path.exists():
        return None

    cs = pd.read_csv(cs_path)
    pf = pd.read_csv(pf_path)
    for df in (cs, pf):
        if "year" in df.columns:
            df["year"] = pd.to_numeric(df["year"], errors="coerce").astype("Int64")
    if "partner" in pf.columns:
        pf = pf[~pf["partner"].isin(AGGREGATE_PARTNERS)]
    return {"cs": cs, "pf": pf}


print("Loading commodity data...")
DATA = {}
for cat in COMMODITIES:
    d = load_commodity(cat)
    if d:
        DATA[cat] = d
        print(f"  ✓ {cat}")
    else:
        print(f"  ✗ {cat} (not yet available)")

AVAILABLE      = list(DATA.keys())
DEFAULT_COMM   = AVAILABLE[0] if AVAILABLE else "energy"
YEARS          = sorted(
    pd.to_numeric(DATA[DEFAULT_COMM]["cs"]["year"].dropna()).astype(int).unique()
)
MIN_YEAR, MAX_YEAR = YEARS[0], YEARS[-1]

# Country list for compare dropdown (built from most complete dataset)
_ref_cs = DATA[DEFAULT_COMM]["cs"]
COUNTRY_OPTIONS = sorted(
    [{"label": r["reporter"], "value": r["reporter_iso3"]}
     for _, r in _ref_cs[["reporter", "reporter_iso3"]].drop_duplicates().dropna().iterrows()],
    key=lambda x: x["label"],
)

COMPARE_COLOR = "#06b6d4"   # cyan — second country in comparisons

# Minimum trade value (USD) to include a country in Top Movers.
# Filters out tiny/sporadic reporters (Comoros, Samoa, etc.)
MOVERS_MIN_TRADE = 500_000_000   # $500M floor in the base year

# Precompute dependency race data per commodity (lazy cache filled on first request)
RACE_CACHE: dict = {}


def _build_race_data(commodity: str) -> pd.DataFrame:
    """
    For each year, compute top-partner import share % per country.
    Returns DataFrame: reporter, year, top1_share, top1_partner, total_imports
    Filters to countries with >= $500M total imports in that year.
    """
    pf = DATA[commodity]["pf"]
    imp = pf[pf["flow"] == "Import"].copy()
    if imp.empty:
        return pd.DataFrame()

    grp_cols = [c for c in ["reporter", "reporter_iso3", "year", "partner"] if c in imp.columns]
    by_rpy = imp.groupby(grp_cols, dropna=False)["trade_value_usd"].sum().reset_index()

    id_cols = [c for c in ["reporter", "reporter_iso3", "year"] if c in by_rpy.columns]
    totals = (by_rpy.groupby(id_cols)["trade_value_usd"].sum()
              .reset_index().rename(columns={"trade_value_usd": "total"}))
    top1   = (by_rpy.sort_values("trade_value_usd", ascending=False)
              .groupby(id_cols).first().reset_index()
              .rename(columns={"trade_value_usd": "top1_val", "partner": "top1_partner"}))

    merged = totals.merge(top1[id_cols + ["top1_val", "top1_partner"]], on=id_cols)
    merged = merged[merged["total"] >= MOVERS_MIN_TRADE]
    merged["top1_share"] = merged["top1_val"] / merged["total"] * 100
    merged["year"] = merged["year"].astype(int)
    return merged


# ── Helpers ───────────────────────────────────────────────────────────────────

def fmt_usd(v: float) -> str:
    if abs(v) >= 1e9: return f"${v/1e9:.1f}B"
    if abs(v) >= 1e6: return f"${v/1e6:.0f}M"
    return f"${v/1e3:.0f}K"


def empty_fig(msg="No data") -> go.Figure:
    fig = go.Figure()
    fig.add_annotation(text=msg, x=0.5, y=0.5, showarrow=False,
                       font=dict(color=TEXT_MUTED, size=14), xref="paper", yref="paper")
    fig.update_layout(paper_bgcolor="rgba(0,0,0,0)", plot_bgcolor="rgba(0,0,0,0)",
                      margin=dict(l=0, r=0, t=0, b=0),
                      xaxis=dict(visible=False), yaxis=dict(visible=False))
    return fig


BASE_LAYOUT = dict(
    paper_bgcolor="rgba(0,0,0,0)", plot_bgcolor="rgba(0,0,0,0)",
    font=dict(color=TEXT_MAIN, family=FONT),
    margin=dict(l=55, r=20, t=40, b=40),
)

# ── App ───────────────────────────────────────────────────────────────────────

app = dash.Dash(__name__)
app.title = "Global Trade Explorer"
server = app.server  # exposed for gunicorn (Render deployment)


def _tab_style():
    return {
        "backgroundColor": DARK_BG, "color": TEXT_MUTED,
        "border": "none", "padding": "10px 20px", "fontSize": "13px",
        "fontWeight": "500", "cursor": "pointer",
    }

def _tab_selected_style():
    return {
        "backgroundColor": DARK_BG, "color": TEXT_MAIN,
        "borderTop": "2px solid #38bdf8", "border": "none",
        "borderBottom": f"1px solid {DARK_BG}",
        "padding": "10px 20px", "fontSize": "13px", "fontWeight": "600",
    }


def commodity_pills():
    return dcc.RadioItems(
        id="commodity-selector",
        options=[
            {
                "label": html.Span(
                    COMMODITIES[c]["label"],
                    style={"opacity": "1" if c in AVAILABLE else "0.35"},
                ),
                "value": c,
                "disabled": c not in AVAILABLE,
            }
            for c in COMMODITIES
        ],
        value=DEFAULT_COMM,
        inline=True,
        inputStyle={"display": "none"},
        labelStyle={
            "marginRight": "6px", "padding": "6px 16px",
            "borderRadius": "20px", "cursor": "pointer",
            "fontSize": "14px", "fontWeight": "500",
            "border": f"1px solid {BORDER}",
            "backgroundColor": PANEL_BG,
        },
        style={"display": "flex", "flexWrap": "wrap", "gap": "6px"},
    )


app.layout = html.Div(
    style={"fontFamily": FONT, "margin": "0", "backgroundColor": DARK_BG,
           "color": TEXT_MAIN, "minHeight": "100vh"},
    children=[

        # ── Header ────────────────────────────────────────────────────────────
        html.Div(
            style={"padding": "14px 32px", "borderBottom": f"1px solid {BORDER}",
                   "display": "flex", "alignItems": "center",
                   "justifyContent": "space-between", "flexWrap": "wrap", "gap": "12px"},
            children=[
                html.Div([
                    html.H1("🌍 Global Trade Explorer",
                            style={"margin": 0, "fontSize": "21px", "fontWeight": "700"}),
                    html.P("Bilateral trade flows by commodity — UN Comtrade 2000–2023",
                           style={"margin": "2px 0 0", "color": TEXT_MUTED, "fontSize": "13px"}),
                ]),
                commodity_pills(),
            ],
        ),

        # ── Controls ──────────────────────────────────────────────────────────
        html.Div(
            style={"padding": "10px 32px", "backgroundColor": PANEL_BG,
                   "display": "flex", "alignItems": "center", "gap": "28px", "flexWrap": "wrap"},
            children=[
                html.Div(style={"flex": "1", "minWidth": "300px"}, children=[
                    html.Label("Year", style={"fontSize": "12px", "color": TEXT_MUTED,
                                              "fontWeight": "500"}),
                    dcc.Slider(id="year-slider", min=MIN_YEAR, max=MAX_YEAR, step=1,
                               value=MAX_YEAR,
                               marks={y: str(y) for y in range(MIN_YEAR, MAX_YEAR + 1, 4)},
                               tooltip={"placement": "bottom", "always_visible": True}),
                ]),
                html.Div(
                    style={"display": "flex", "alignItems": "center", "gap": "10px"},
                    children=[
                        html.Label("Map:", style={"fontSize": "13px", "color": TEXT_MUTED}),
                        dcc.RadioItems(
                            id="flow-toggle",
                            options=[{"label": f" {l}", "value": v} for l, v in
                                     [("Total", "total"), ("Imports", "Import"), ("Exports", "Export")]],
                            value="total", inline=True,
                            labelStyle={"marginRight": "14px", "fontSize": "14px", "cursor": "pointer"},
                        ),
                    ],
                ),
            ],
        ),

        # ── Map + Side panel ──────────────────────────────────────────────────
        html.Div(
            style={"display": "flex", "flexWrap": "wrap"},
            children=[
                html.Div(style={"flex": "2", "minWidth": "500px"}, children=[
                    dcc.Graph(id="choropleth", style={"height": "480px"},
                              config={"displayModeBar": False}),
                ]),
                html.Div(
                    id="side-panel",
                    style={"flex": "1", "minWidth": "340px", "maxWidth": "460px",
                           "padding": "16px 20px", "backgroundColor": PANEL_BG,
                           "overflowY": "auto", "maxHeight": "480px"},
                    children=[html.Div(id="country-info", children=[
                        html.P("Click a country to explore its trade.",
                               style={"color": TEXT_MUTED, "fontSize": "14px",
                                      "marginTop": "60px", "textAlign": "center"}),
                    ])],
                ),
            ],
        ),

        # ── Bottom analysis section ───────────────────────────────────────────
        html.Div(
            id="analysis-section",
            style={"display": "none"},
            children=[
                html.Div(
                    style={"borderTop": f"1px solid {BORDER}",
                           "padding": "0 32px 8px",
                           "backgroundColor": DARK_BG},
                    children=[
                        dcc.Tabs(
                            id="analysis-tabs",
                            value="tab-history",
                            style={"borderBottom": f"1px solid {BORDER}"},
                            children=[
                                dcc.Tab(label="📈  Trade History",   value="tab-history",
                                        style=_tab_style(), selected_style=_tab_selected_style()),
                                dcc.Tab(label="🔀  Trade Flows",     value="tab-sankey",
                                        style=_tab_style(), selected_style=_tab_selected_style()),
                                dcc.Tab(label="⚠️  Dependency",      value="tab-dependency",
                                        style=_tab_style(), selected_style=_tab_selected_style()),
                                dcc.Tab(label="🆚  Compare",         value="tab-compare",
                                        style=_tab_style(), selected_style=_tab_selected_style()),
                            ],
                        ),
                        # Tab content containers
                        html.Div(id="tab-history-content",    style={"display": "block"}),
                        html.Div(id="tab-sankey-content",     style={"display": "none"}),
                        html.Div(id="tab-dependency-content", style={"display": "none"}),
                        html.Div(id="tab-compare-content",    style={"display": "none"}, children=[
                            html.Div(
                                style={"padding": "14px 0 8px",
                                       "display": "flex", "alignItems": "center", "gap": "14px"},
                                children=[
                                    html.Label("Compare with:",
                                               style={"fontSize": "13px", "color": TEXT_MUTED,
                                                      "whiteSpace": "nowrap"}),
                                    dcc.Dropdown(
                                        id="compare-dropdown",
                                        options=COUNTRY_OPTIONS,
                                        placeholder="Select a country…",
                                        clearable=True,
                                        style={"width": "280px", "fontSize": "13px",
                                               "backgroundColor": PANEL_BG},
                                    ),
                                ],
                            ),
                            html.Div(id="compare-content"),
                        ]),
                    ],
                ),
            ],
        ),

        # ── Top Movers section ────────────────────────────────────────────────
        html.Div(
            style={"borderTop": f"1px solid {BORDER}", "padding": "16px 32px 24px"},
            children=[
                html.Div(
                    style={"display": "flex", "alignItems": "center", "justifyContent": "space-between",
                           "flexWrap": "wrap", "gap": "10px", "marginBottom": "4px"},
                    children=[
                        html.Div(style={"display": "flex", "alignItems": "baseline", "gap": "12px"},
                                 children=[
                                     html.H3("📊 Top Movers",
                                             style={"margin": 0, "fontSize": "15px", "fontWeight": "700"}),
                                     html.Span(id="top-movers-subtitle",
                                               style={"fontSize": "12px", "color": TEXT_MUTED}),
                                 ]),
                        dcc.RadioItems(
                            id="movers-flow-toggle",
                            options=[
                                {"label": " Total",   "value": "total"},
                                {"label": " Imports", "value": "Import"},
                                {"label": " Exports", "value": "Export"},
                            ],
                            value="total", inline=True,
                            labelStyle={"marginRight": "14px", "fontSize": "13px",
                                        "cursor": "pointer", "color": TEXT_MAIN},
                            inputStyle={"marginRight": "4px", "accentColor": "#22c55e"},
                        ),
                    ],
                ),
                html.P(id="movers-description",
                       style={"margin": "0 0 10px", "fontSize": "12px", "color": TEXT_MUTED}),
                dcc.Graph(id="top-movers-chart", config={"displayModeBar": False}),
            ],
        ),

        # ── Dependency Bar Race section ───────────────────────────────────────
        html.Div(
            style={"borderTop": f"1px solid {BORDER}", "padding": "16px 32px 24px"},
            children=[
                html.Div(style={"display": "flex", "alignItems": "baseline",
                                "gap": "12px", "marginBottom": "4px"}, children=[
                    html.H3("🏁 Dependency Race",
                            style={"margin": 0, "fontSize": "15px", "fontWeight": "700"}),
                    html.Span(id="race-subtitle",
                              style={"fontSize": "12px", "color": TEXT_MUTED}),
                ]),
                html.P("Top 15 most import-concentrated countries over time "
                       "(% of total imports from a single partner). Press ▶ to animate.",
                       style={"margin": "0 0 10px", "fontSize": "12px", "color": TEXT_MUTED}),
                dcc.Graph(id="bar-race-chart", config={"displayModeBar": False}),
            ],
        ),

        dcc.Store(id="selected-iso3", data=None),
    ],
)


# ── Callback: choropleth ──────────────────────────────────────────────────────

@callback(
    Output("choropleth", "figure"),
    Input("year-slider", "value"),
    Input("flow-toggle", "value"),
    Input("commodity-selector", "value"),
)
def update_map(year, flow, commodity):
    if commodity not in DATA:
        return empty_fig("No data available")

    cs = DATA[commodity]["cs"]
    col_map = {"total": "total_trade", "Import": "total_imports", "Export": "total_exports"}
    val_col = col_map.get(flow, "total_trade")

    subset = cs[cs["year"] == year].copy()
    if val_col not in subset.columns:
        subset["total_trade"] = subset.get("total_imports", 0) + subset.get("total_exports", 0)
        val_col = "total_trade"

    subset = subset.dropna(subset=["reporter_iso3", val_col]).copy() if "reporter_iso3" in subset.columns else subset
    subset = subset[subset[val_col] > 0] if len(subset) > 0 else subset

    q95 = subset[val_col].quantile(0.95) if len(subset) > 0 else 1.0
    color_max = float(q95) if pd.notna(q95) and q95 > 0 else 1.0

    fig = px.choropleth(
        subset, locations="reporter_iso3", color=val_col, hover_name="reporter",
        color_continuous_scale="YlOrRd", range_color=[0, color_max],
        labels={val_col: "Trade Value (USD)"},
    )
    fig.update_layout(
        geo=dict(showframe=False, showcoastlines=True, coastlinecolor=BORDER,
                 landcolor=PANEL_BG, oceancolor=DARK_BG,
                 projection_type="natural earth", bgcolor="rgba(0,0,0,0)"),
        paper_bgcolor="rgba(0,0,0,0)", plot_bgcolor="rgba(0,0,0,0)",
        coloraxis_colorbar=dict(title=dict(text="USD", font=dict(color=TEXT_MUTED)),
                                tickfont=dict(color=TEXT_MUTED), bgcolor="rgba(0,0,0,0)"),
        margin=dict(l=0, r=0, t=10, b=10),
        font=dict(color=TEXT_MAIN),
    )
    return fig


# ── Callback: side panel ──────────────────────────────────────────────────────

@callback(
    Output("country-info", "children"),
    Output("selected-iso3", "data"),
    Input("choropleth", "clickData"),
    State("year-slider", "value"),
    State("commodity-selector", "value"),
)
def update_side_panel(click_data, year, commodity):
    if click_data is None or commodity not in DATA:
        return (html.P("Click a country to explore its trade.",
                       style={"color": TEXT_MUTED, "fontSize": "14px",
                              "marginTop": "60px", "textAlign": "center"}),
                None)

    iso3 = click_data["points"][0]["location"]
    name = click_data["points"][0].get("hovertext", iso3)
    cat_color = COMMODITIES[commodity]["color"]

    cs = DATA[commodity]["cs"]
    pf = DATA[commodity]["pf"]

    row = cs[(cs.get("reporter_iso3", pd.Series(dtype=str)) == iso3) & (cs["year"] == year)]

    if row.empty:
        return (html.Div([
            html.H3(name, style={"margin": "0 0 8px", "fontSize": "17px"}),
            html.P(f"No data for {year}.", style={"color": TEXT_MUTED}),
        ]), iso3)

    total_imp = float(row["total_imports"].iloc[0]) if "total_imports" in row else 0.0
    total_exp = float(row["total_exports"].iloc[0]) if "total_exports" in row else 0.0
    balance   = total_exp - total_imp
    bal_color = "#22c55e" if balance >= 0 else "#ef4444"
    bal_label = "surplus" if balance >= 0 else "deficit"

    bilateral = pf[(pf.get("reporter_iso3", pd.Series(dtype=str)) == iso3) & (pf["year"] == year)] \
        if "reporter_iso3" in pf.columns else pf[(pf["reporter"] == name) & (pf["year"] == year)]

    def partner_bar(flow_label, color):
        d = (bilateral[bilateral["flow"] == flow_label]
             .groupby("partner")["trade_value_usd"].sum()
             .sort_values(ascending=False).head(10)
             .sort_values(ascending=True).reset_index())
        if d.empty:
            return html.P(f"No {flow_label.lower()} data.",
                          style={"color": "#64748b", "fontSize": "13px"})
        h = max(150, len(d) * 26)
        fig = go.Figure(go.Bar(
            x=d["trade_value_usd"], y=d["partner"], orientation="h",
            marker_color=color,
            customdata=[fmt_usd(v) for v in d["trade_value_usd"]],
            hovertemplate="%{y}: %{customdata}<extra></extra>",
        ))
        fig.update_layout(height=h, margin=dict(l=0, r=0, t=4, b=4),
                          paper_bgcolor="rgba(0,0,0,0)", plot_bgcolor="rgba(0,0,0,0)",
                          font=dict(color=TEXT_MAIN, size=11),
                          xaxis=dict(showgrid=False, showticklabels=False),
                          yaxis=dict(showgrid=False))
        return dcc.Graph(figure=fig, config={"displayModeBar": False},
                         style={"height": f"{h}px"})

    content = html.Div([
        html.H3(name, style={"margin": "0 0 2px", "fontSize": "17px", "fontWeight": "700"}),
        html.P(f"{COMMODITIES[commodity]['label']} · {year}",
               style={"color": cat_color, "fontSize": "12px", "margin": "0 0 12px",
                      "fontWeight": "500"}),
        html.Div(style={"display": "flex", "gap": "10px", "marginBottom": "14px"}, children=[
            html.Div([html.Div("Imports", style={"fontSize": "11px", "color": TEXT_MUTED}),
                      html.Div(fmt_usd(total_imp), style={"fontSize": "16px", "fontWeight": "600",
                                                           "color": IMP_COLOR})], style={"flex": 1}),
            html.Div([html.Div("Exports", style={"fontSize": "11px", "color": TEXT_MUTED}),
                      html.Div(fmt_usd(total_exp), style={"fontSize": "16px", "fontWeight": "600",
                                                           "color": EXP_COLOR})], style={"flex": 1}),
            html.Div([html.Div("Balance", style={"fontSize": "11px", "color": TEXT_MUTED}),
                      html.Div(f"{fmt_usd(balance)} {bal_label}",
                               style={"fontSize": "16px", "fontWeight": "600",
                                      "color": bal_color})], style={"flex": 1}),
        ]),
        html.H4("Top Import Sources",
                style={"margin": "0 0 4px", "fontSize": "13px", "color": IMP_COLOR}),
        partner_bar("Import", IMP_COLOR),
        html.Div(style={"height": "10px"}),
        html.H4("Top Export Destinations",
                style={"margin": "0 0 4px", "fontSize": "13px", "color": EXP_COLOR}),
        partner_bar("Export", EXP_COLOR),
    ])
    return content, iso3


# ── Callback: show/hide analysis section + tab visibility ─────────────────────

@callback(
    Output("analysis-section",       "style"),
    Output("tab-history-content",    "style"),
    Output("tab-sankey-content",     "style"),
    Output("tab-dependency-content", "style"),
    Output("tab-compare-content",    "style"),
    Input("choropleth", "clickData"),
    Input("analysis-tabs", "value"),
)
def toggle_analysis_section(click_data, active_tab):
    hidden = {"display": "none"}
    if click_data is None:
        return hidden, hidden, hidden, hidden, hidden

    show = {"display": "block"}
    tab_styles = {
        "tab-history":    [show,   hidden, hidden, hidden],
        "tab-sankey":     [hidden, show,   hidden, hidden],
        "tab-dependency": [hidden, hidden, show,   hidden],
        "tab-compare":    [hidden, hidden, hidden, show  ],
    }
    styles = tab_styles.get(active_tab, [show, hidden, hidden, hidden])
    return {"display": "block"}, *styles


# ── Callback: Trade History (time series) ─────────────────────────────────────

@callback(
    Output("tab-history-content", "children"),
    Input("choropleth", "clickData"),
    Input("commodity-selector", "value"),
    State("year-slider", "value"),
)
def update_timeseries(click_data, commodity, year):
    if click_data is None or commodity not in DATA:
        return None

    iso3 = click_data["points"][0]["location"]
    name = click_data["points"][0].get("hovertext", iso3)
    cs   = DATA[commodity]["cs"]

    country_ts = cs[cs.get("reporter_iso3", pd.Series(dtype=str)) == iso3].sort_values("year") \
        if "reporter_iso3" in cs.columns else cs[cs["reporter"] == name].sort_values("year")

    if country_ts.empty or "total_imports" not in country_ts.columns:
        return dcc.Graph(figure=empty_fig("No time series data"), style={"height": "260px"})

    fig = go.Figure()
    fig.add_trace(go.Scatter(
        x=country_ts["year"], y=country_ts["total_imports"],
        name="Imports", mode="lines+markers",
        line=dict(color=IMP_COLOR, width=2), marker=dict(size=4),
        customdata=[fmt_usd(v) for v in country_ts["total_imports"]],
        hovertemplate="%{x}: %{customdata}<extra>Imports</extra>",
    ))
    fig.add_trace(go.Scatter(
        x=country_ts["year"], y=country_ts["total_exports"],
        name="Exports", mode="lines+markers",
        line=dict(color=EXP_COLOR, width=2), marker=dict(size=4),
        customdata=[fmt_usd(v) for v in country_ts["total_exports"]],
        hovertemplate="%{x}: %{customdata}<extra>Exports</extra>",
    ))
    fig.add_vline(x=year, line_dash="dash", line_color=TEXT_MUTED, line_width=1,
                  annotation_text=str(year), annotation_font_color=TEXT_MUTED,
                  annotation_position="top right")

    fig.update_layout(**BASE_LAYOUT, height=280,
                      title=dict(text=f"{name} — {COMMODITIES[commodity]['label']} trade 2000–2023",
                                 font=dict(size=13, color=TEXT_MUTED), x=0),
                      legend=dict(orientation="h", x=0, y=1.12,
                                  font=dict(color=TEXT_MUTED, size=12)),
                      xaxis=dict(showgrid=False, color=TEXT_MUTED, dtick=4),
                      yaxis=dict(showgrid=True, gridcolor=BORDER, color=TEXT_MUTED,
                                 tickprefix="$"))
    return dcc.Graph(figure=fig, config={"displayModeBar": False})


# ── Callback: Trade Flows (Sankey) ────────────────────────────────────────────

@callback(
    Output("tab-sankey-content", "children"),
    Input("choropleth", "clickData"),
    Input("year-slider", "value"),
    Input("commodity-selector", "value"),
)
def update_sankey(click_data, year, commodity):
    if click_data is None or commodity not in DATA:
        return None

    iso3 = click_data["points"][0]["location"]
    name = click_data["points"][0].get("hovertext", iso3)
    pf   = DATA[commodity]["pf"]

    bilateral = pf[(pf.get("reporter_iso3", pd.Series(dtype=str)) == iso3) & (pf["year"] == year)] \
        if "reporter_iso3" in pf.columns else pf[(pf["reporter"] == name) & (pf["year"] == year)]

    TOP_N = 8
    imp_df = (bilateral[bilateral["flow"] == "Import"]
              .groupby("partner")["trade_value_usd"].sum()
              .sort_values(ascending=False).head(TOP_N).reset_index())
    exp_df = (bilateral[bilateral["flow"] == "Export"]
              .groupby("partner")["trade_value_usd"].sum()
              .sort_values(ascending=False).head(TOP_N).reset_index())

    if imp_df.empty and exp_df.empty:
        return dcc.Graph(figure=empty_fig("No bilateral data for this country / year"),
                         style={"height": "320px"})

    # Build node list: [import sources ... | COUNTRY | export destinations ...]
    imp_partners = imp_df["partner"].tolist()
    exp_partners = exp_df["partner"].tolist()

    all_nodes  = imp_partners + [name] + exp_partners
    node_idx   = {n: i for i, n in enumerate(all_nodes)}
    center_idx = node_idx[name]

    # Node colors
    cat_color = COMMODITIES[commodity]["color"]
    node_colors = (
        [f"rgba(249,115,22,0.7)"] * len(imp_partners)   # orange for import sources
        + [cat_color]                                     # commodity color for center
        + [f"rgba(59,130,246,0.7)"] * len(exp_partners)  # blue for export dests
    )

    # Links
    src, tgt, val, link_colors = [], [], [], []

    for _, row_d in imp_df.iterrows():
        src.append(node_idx[row_d["partner"]])
        tgt.append(center_idx)
        val.append(row_d["trade_value_usd"])
        link_colors.append("rgba(249,115,22,0.25)")

    for _, row_d in exp_df.iterrows():
        src.append(center_idx)
        tgt.append(node_idx[row_d["partner"]])
        val.append(row_d["trade_value_usd"])
        link_colors.append("rgba(59,130,246,0.25)")

    formatted_vals = [fmt_usd(v) for v in val]

    fig = go.Figure(go.Sankey(
        arrangement="snap",
        node=dict(
            label=all_nodes,
            color=node_colors,
            pad=16, thickness=20,
            line=dict(color=BORDER, width=0.5),
            hovertemplate="%{label}<extra></extra>",
        ),
        link=dict(
            source=src, target=tgt, value=val,
            color=link_colors,
            customdata=formatted_vals,
            hovertemplate="%{source.label} → %{target.label}: %{customdata}<extra></extra>",
        ),
    ))
    fig.update_layout(
        **{k: v for k, v in BASE_LAYOUT.items() if k != "margin"},
        height=360,
        margin=dict(l=20, r=20, t=50, b=20),
        title=dict(
            text=f"{name} — {COMMODITIES[commodity]['label']} trade flows · {year}"
                 f"  <span style='font-size:11px;color:{TEXT_MUTED}'>"
                 f"(left = import sources, right = export destinations)</span>",
            font=dict(size=13, color=TEXT_MUTED), x=0,
        ),
    )
    return dcc.Graph(figure=fig, config={"displayModeBar": False})


# ── Callback: Dependency chart ────────────────────────────────────────────────

@callback(
    Output("tab-dependency-content", "children"),
    Input("choropleth", "clickData"),
    Input("commodity-selector", "value"),
    State("year-slider", "value"),
)
def update_dependency(click_data, commodity, year):
    if click_data is None or commodity not in DATA:
        return None

    iso3 = click_data["points"][0]["location"]
    name = click_data["points"][0].get("hovertext", iso3)
    pf   = DATA[commodity]["pf"]

    country_pf = pf[pf.get("reporter_iso3", pd.Series(dtype=str)) == iso3] \
        if "reporter_iso3" in pf.columns else pf[pf["reporter"] == name]

    imp_pf = country_pf[country_pf["flow"] == "Import"]
    if imp_pf.empty:
        return dcc.Graph(figure=empty_fig("No import data to compute dependency"),
                         style={"height": "320px"})

    rows = []
    for yr in sorted(imp_pf["year"].dropna().unique()):
        yr_data = imp_pf[imp_pf["year"] == yr]
        by_partner = yr_data.groupby("partner")["trade_value_usd"].sum().sort_values(ascending=False)
        total = by_partner.sum()
        if total <= 0:
            continue
        top1_share  = by_partner.iloc[0] / total * 100
        top3_share  = by_partner.head(3).sum() / total * 100
        top1_name   = by_partner.index[0]
        rows.append({"year": int(yr), "top1_share": top1_share,
                     "top3_share": top3_share, "top1_partner": top1_name})

    if not rows:
        return dcc.Graph(figure=empty_fig("Not enough data"), style={"height": "320px"})

    dep = pd.DataFrame(rows)
    cat_color = COMMODITIES[commodity]["color"]

    fig = go.Figure()

    # Background concentration zones
    for y0, y1, label, color in [
        (0, 33,  "Diversified",  "rgba(34,197,94,0.06)"),
        (33, 66, "Moderate",     "rgba(234,179,8,0.06)"),
        (66, 100,"Concentrated", "rgba(239,68,68,0.06)"),
    ]:
        fig.add_hrect(y0=y0, y1=y1, fillcolor=color, line_width=0,
                      annotation_text=label, annotation_position="right",
                      annotation_font=dict(color=TEXT_MUTED, size=10))

    # Top-3 band (filled area)
    fig.add_trace(go.Scatter(
        x=dep["year"], y=dep["top3_share"],
        name="Top-3 partners share", mode="lines",
        line=dict(color=cat_color, width=1, dash="dot"),
        fill="tonexty", fillcolor=f"rgba(148,163,184,0.08)",
        hovertemplate="%{x} — Top-3: %{y:.1f}%<extra></extra>",
    ))
    # Top-1 line
    fig.add_trace(go.Scatter(
        x=dep["year"], y=dep["top1_share"],
        name="Top partner share", mode="lines+markers",
        line=dict(color=cat_color, width=2.5), marker=dict(size=5),
        customdata=dep["top1_partner"],
        hovertemplate="%{x} — #1 partner: <b>%{customdata}</b> (%{y:.1f}%)<extra></extra>",
    ))
    # Marker at selected year
    sel = dep[dep["year"] == year]
    if not sel.empty:
        fig.add_trace(go.Scatter(
            x=sel["year"], y=sel["top1_share"],
            mode="markers", showlegend=False,
            marker=dict(size=11, color=cat_color, line=dict(color=TEXT_MAIN, width=2)),
            hoverinfo="skip",
        ))
    fig.add_vline(x=year, line_dash="dash", line_color=TEXT_MUTED, line_width=1)

    fig.update_layout(
        **BASE_LAYOUT, height=320,
        title=dict(
            text=f"{name} — Import dependency on top partner · {COMMODITIES[commodity]['label']}",
            font=dict(size=13, color=TEXT_MUTED), x=0,
        ),
        legend=dict(orientation="h", x=0, y=1.12, font=dict(color=TEXT_MUTED, size=12)),
        xaxis=dict(showgrid=False, color=TEXT_MUTED, dtick=4, range=[MIN_YEAR - 0.5, MAX_YEAR + 0.5]),
        yaxis=dict(showgrid=False, color=TEXT_MUTED, ticksuffix="%", range=[0, 105]),
    )
    return dcc.Graph(figure=fig, config={"displayModeBar": False})


# ── Callback: Country Comparison ─────────────────────────────────────────────

@callback(
    Output("compare-content", "children"),
    Input("choropleth", "clickData"),
    Input("compare-dropdown", "value"),
    Input("commodity-selector", "value"),
    State("year-slider", "value"),
)
def update_compare(click_data, compare_iso3, commodity, year):
    if click_data is None or commodity not in DATA:
        return None

    iso3_a = click_data["points"][0]["location"]
    name_a = click_data["points"][0].get("hovertext", iso3_a)
    cat_color = COMMODITIES[commodity]["color"]
    cs = DATA[commodity]["cs"]
    pf = DATA[commodity]["pf"]

    if not compare_iso3:
        return html.P("Select a country above to compare.",
                      style={"color": TEXT_MUTED, "fontSize": "13px", "padding": "8px 0"})

    # Resolve country B name
    match = _ref_cs[_ref_cs["reporter_iso3"] == compare_iso3]["reporter"]
    name_b = match.iloc[0] if not match.empty else compare_iso3

    def get_stats(iso3):
        r = cs[(cs["reporter_iso3"] == iso3) & (cs["year"] == year)]
        if r.empty:
            return 0.0, 0.0
        return (float(r["total_imports"].iloc[0]) if "total_imports" in r else 0.0,
                float(r["total_exports"].iloc[0]) if "total_exports" in r else 0.0)

    imp_a, exp_a = get_stats(iso3_a)
    imp_b, exp_b = get_stats(compare_iso3)
    bal_a, bal_b = exp_a - imp_a, exp_b - imp_b

    def stat_card(label, val_a, val_b, fmt_fn=fmt_usd):
        better = "a" if abs(val_a) >= abs(val_b) else "b"
        return html.Div(style={"flex": 1, "textAlign": "center",
                               "padding": "8px", "backgroundColor": "#0f172a",
                               "borderRadius": "8px"}, children=[
            html.Div(label, style={"fontSize": "11px", "color": TEXT_MUTED, "marginBottom": "6px"}),
            html.Div(style={"display": "flex", "justifyContent": "center",
                            "gap": "16px", "alignItems": "baseline"}, children=[
                html.Span(fmt_fn(val_a),
                          style={"fontSize": "16px", "fontWeight": "700", "color": cat_color}),
                html.Span("vs", style={"fontSize": "11px", "color": TEXT_MUTED}),
                html.Span(fmt_fn(val_b),
                          style={"fontSize": "16px", "fontWeight": "700",
                                 "color": COMPARE_COLOR}),
            ]),
        ])

    stats_row = html.Div(style={"display": "flex", "gap": "8px", "marginBottom": "16px"},
                         children=[
                             stat_card("Imports",      imp_a, imp_b),
                             stat_card("Exports",      exp_a, exp_b),
                             stat_card("Trade Balance", bal_a, bal_b),
                         ])

    # ── Overlaid time series ──────────────────────────────────────────────────
    def get_ts(iso3):
        return cs[cs["reporter_iso3"] == iso3].sort_values("year") \
            if "reporter_iso3" in cs.columns else pd.DataFrame()

    ts_a = get_ts(iso3_a)
    ts_b = get_ts(compare_iso3)

    fig_ts = go.Figure()
    for ts, name, color, dash in [
        (ts_a, name_a, cat_color,     "solid"),
        (ts_b, name_b, COMPARE_COLOR, "dot"),
    ]:
        if ts.empty or "total_imports" not in ts.columns:
            continue
        fig_ts.add_trace(go.Scatter(
            x=ts["year"], y=ts["total_imports"], name=f"{name} imports",
            mode="lines", line=dict(color=color, width=2, dash=dash),
            customdata=[fmt_usd(v) for v in ts["total_imports"]],
            hovertemplate=f"{name} imports %{{x}}: %{{customdata}}<extra></extra>",
        ))
        fig_ts.add_trace(go.Scatter(
            x=ts["year"], y=ts["total_exports"], name=f"{name} exports",
            mode="lines", line=dict(color=color, width=1.5, dash="dash" if dash == "solid" else "dashdot"),
            customdata=[fmt_usd(v) for v in ts["total_exports"]],
            hovertemplate=f"{name} exports %{{x}}: %{{customdata}}<extra></extra>",
        ))

    fig_ts.add_vline(x=year, line_dash="dash", line_color=TEXT_MUTED, line_width=1)
    fig_ts.update_layout(
        **{k: v for k, v in BASE_LAYOUT.items() if k != "margin"},
        height=300,
        margin=dict(l=40, r=20, t=70, b=40),
        title=dict(
            text=f"<span style='color:{cat_color}'>{name_a}</span>"
                 f" vs <span style='color:{COMPARE_COLOR}'>{name_b}</span>"
                 f" — {COMMODITIES[commodity]['label']} trade 2000–2023",
            font=dict(size=13, color=TEXT_MUTED), x=0, y=0.97,
        ),
        legend=dict(orientation="h", x=0, y=1.08, font=dict(color=TEXT_MUTED, size=11)),
        xaxis=dict(showgrid=False, color=TEXT_MUTED, dtick=4),
        yaxis=dict(showgrid=True, gridcolor=BORDER, color=TEXT_MUTED, tickprefix="$"),
    )

    # ── Overlaid dependency ───────────────────────────────────────────────────
    def compute_dep(iso3):
        cp = pf[pf["reporter_iso3"] == iso3] if "reporter_iso3" in pf.columns else pd.DataFrame()
        imp = cp[cp["flow"] == "Import"]
        rows = []
        for yr in sorted(imp["year"].dropna().unique()):
            by_p = imp[imp["year"] == yr].groupby("partner")["trade_value_usd"].sum().sort_values(ascending=False)
            total = by_p.sum()
            if total > 0:
                rows.append({"year": int(yr), "top1_share": by_p.iloc[0] / total * 100,
                             "top1_partner": by_p.index[0]})
        return pd.DataFrame(rows)

    dep_a = compute_dep(iso3_a)
    dep_b = compute_dep(compare_iso3)

    fig_dep = go.Figure()
    for y0, y1, label, color in [
        (0, 33,  "Diversified",  "rgba(34,197,94,0.06)"),
        (33, 66, "Moderate",     "rgba(234,179,8,0.06)"),
        (66, 100,"Concentrated", "rgba(239,68,68,0.06)"),
    ]:
        fig_dep.add_hrect(y0=y0, y1=y1, fillcolor=color, line_width=0)

    for dep, name, color, dash in [
        (dep_a, name_a, cat_color,     "solid"),
        (dep_b, name_b, COMPARE_COLOR, "dot"),
    ]:
        if dep.empty:
            continue
        fig_dep.add_trace(go.Scatter(
            x=dep["year"], y=dep["top1_share"], name=name,
            mode="lines+markers", line=dict(color=color, width=2, dash=dash),
            marker=dict(size=4),
            customdata=dep["top1_partner"],
            hovertemplate=f"{name} %{{x}}: #1 partner <b>%{{customdata}}</b> (%{{y:.1f}}%)<extra></extra>",
        ))

    fig_dep.add_vline(x=year, line_dash="dash", line_color=TEXT_MUTED, line_width=1)
    fig_dep.update_layout(
        **BASE_LAYOUT, height=240,
        title=dict(text="Import dependency — top partner share %",
                   font=dict(size=13, color=TEXT_MUTED), x=0),
        legend=dict(orientation="h", x=0, y=1.14, font=dict(color=TEXT_MUTED, size=11)),
        xaxis=dict(showgrid=False, color=TEXT_MUTED, dtick=4,
                   range=[MIN_YEAR - 0.5, MAX_YEAR + 0.5]),
        yaxis=dict(showgrid=False, color=TEXT_MUTED, ticksuffix="%", range=[0, 105]),
    )

    return html.Div([
        html.Div(style={"display": "flex", "gap": "8px", "marginBottom": "6px",
                        "fontSize": "13px"}, children=[
            html.Span(f"● {name_a}", style={"color": cat_color, "fontWeight": "600"}),
            html.Span("vs", style={"color": TEXT_MUTED}),
            html.Span(f"● {name_b}", style={"color": COMPARE_COLOR, "fontWeight": "600"}),
            html.Span(f"· {COMMODITIES[commodity]['label']} · {year}",
                      style={"color": TEXT_MUTED}),
        ]),
        stats_row,
        dcc.Graph(figure=fig_ts,  config={"displayModeBar": False}),
        dcc.Graph(figure=fig_dep, config={"displayModeBar": False}),
    ])


# ── Callback: Top Movers ──────────────────────────────────────────────────────

MOVERS_DESCRIPTIONS = {
    "total":  "Biggest year-over-year change in total trade volume (imports + exports)",
    "Import": "Who increased import dependency? (YoY change in import volume)",
    "Export": "Who gained market power? (YoY change in export volume)",
}

@callback(
    Output("top-movers-chart",    "figure"),
    Output("top-movers-subtitle", "children"),
    Output("movers-description",  "children"),
    Input("year-slider", "value"),
    Input("commodity-selector", "value"),
    Input("movers-flow-toggle",   "value"),
)
def update_top_movers(year, commodity, flow):
    if commodity not in DATA or year <= MIN_YEAR:
        return empty_fig("Select a year after 2000"), "", ""

    cs   = DATA[commodity]["cs"]
    prev = year - 1

    col_map = {"total": "total_trade", "Import": "total_imports", "Export": "total_exports"}
    val_col = col_map[flow]

    def get_vals(yr):
        sub = cs[cs["year"] == yr].copy()
        if val_col == "total_trade" and val_col not in sub.columns:
            sub["total_trade"] = sub.get("total_imports", 0) + sub.get("total_exports", 0)
        return (sub[["reporter", "reporter_iso3", val_col]]
                .dropna(subset=["reporter_iso3", val_col])
                .rename(columns={val_col: "val"}))

    cur  = get_vals(year).rename(columns={"val": "val_cur"})
    prv  = get_vals(prev).rename(columns={"val": "val_prev"})
    merged = cur.merge(prv, on=["reporter", "reporter_iso3"], how="inner")

    # Quality filter: base-year trade must be above threshold to suppress noise
    merged = merged[merged["val_prev"] >= MOVERS_MIN_TRADE]
    merged = merged[merged["val_prev"] > 0]

    merged["pct_change"] = (merged["val_cur"] - merged["val_prev"]) / merged["val_prev"] * 100
    merged["abs_change"] = merged["val_cur"] - merged["val_prev"]

    TOP_N = 12
    gainers = merged.nlargest(TOP_N, "pct_change")
    losers  = merged.nsmallest(TOP_N, "pct_change")
    movers  = pd.concat([losers, gainers]).drop_duplicates("reporter").sort_values("pct_change")

    colors = ["#22c55e" if v >= 0 else "#ef4444" for v in movers["pct_change"]]
    custom = [
        [f"{r['pct_change']:+.0f}%",
         f"{fmt_usd(abs(r['abs_change']))} {'gain' if r['pct_change'] >= 0 else 'loss'}"]
        for _, r in movers.iterrows()
    ]

    fig = go.Figure(go.Bar(
        x=movers["pct_change"], y=movers["reporter"],
        orientation="h", marker_color=colors,
        customdata=custom,
        hovertemplate="<b>%{y}</b><br>%{customdata[0]} YoY  (%{customdata[1]})<extra></extra>",
    ))
    fig.add_vline(x=0, line_color=BORDER, line_width=1.5)
    fig.update_layout(
        **{k: v for k, v in BASE_LAYOUT.items() if k != "margin"},
        height=max(360, len(movers) * 24 + 80),
        margin=dict(l=160, r=80, t=20, b=40),
        xaxis=dict(showgrid=True, gridcolor=BORDER, color=TEXT_MUTED,
                   ticksuffix="%", zeroline=False),
        yaxis=dict(showgrid=False, color=TEXT_MAIN, tickfont=dict(size=12)),
        bargap=0.35,
    )
    flow_label = {"total": "Total", "Import": "Imports", "Export": "Exports"}[flow]
    subtitle = f"{prev} → {year}  ·  {COMMODITIES[commodity]['label']}  ·  {flow_label}"
    return fig, subtitle, MOVERS_DESCRIPTIONS[flow]


# ── Callback: Dependency Bar Race ─────────────────────────────────────────────

@callback(
    Output("bar-race-chart", "figure"),
    Output("race-subtitle",  "children"),
    Input("commodity-selector", "value"),
)
def update_bar_race(commodity):
    if commodity not in DATA:
        return empty_fig("No data"), ""

    # Build (or retrieve from cache) the full dependency dataset
    if commodity not in RACE_CACHE:
        RACE_CACHE[commodity] = _build_race_data(commodity)
    race = RACE_CACHE[commodity]

    if race.empty:
        return empty_fig("Not enough data to build race"), ""

    years = sorted(race["year"].unique())
    TOP_N = 15

    def zone_color(share):
        if share >= 66: return "#ef4444"
        if share >= 33: return "#eab308"
        return "#22c55e"

    # Build initial frame (first year)
    def make_bar_data(yr):
        yr_data = (race[race["year"] == yr]
                   .sort_values("top1_share", ascending=True)
                   .tail(TOP_N))
        colors  = [zone_color(s) for s in yr_data["top1_share"]]
        custom  = list(zip(yr_data["top1_partner"], yr_data["total"].apply(fmt_usd)))
        return go.Bar(
            x=yr_data["top1_share"],
            y=yr_data["reporter"],
            orientation="h",
            marker_color=colors,
            customdata=custom,
            hovertemplate=(
                "<b>%{y}</b><br>"
                "Top partner: %{customdata[0]}<br>"
                "Dependency: %{x:.1f}%<br>"
                "Total imports: %{customdata[1]}"
                "<extra></extra>"
            ),
        )

    frames = [
        go.Frame(data=[make_bar_data(yr)], name=str(yr),
                 layout=go.Layout(title_text=f"Import dependency race · {yr}"))
        for yr in years
    ]

    fig = go.Figure(
        data=[make_bar_data(years[0])],
        frames=frames,
    )

    # Background zones as shapes
    for x0, x1, color in [(0, 33, "rgba(34,197,94,0.06)"),
                           (33, 66, "rgba(234,179,8,0.06)"),
                           (66, 100, "rgba(239,68,68,0.06)")]:
        fig.add_vrect(x0=x0, x1=x1, fillcolor=color, line_width=0)

    # Play / Pause buttons
    fig.update_layout(
        **{k: v for k, v in BASE_LAYOUT.items() if k != "margin"},
        height=460,
        margin=dict(l=160, r=80, t=60, b=40),
        title=dict(text=f"Import dependency race · {years[0]}",
                   font=dict(size=13, color=TEXT_MUTED), x=0),
        xaxis=dict(range=[0, 105], showgrid=True, gridcolor=BORDER,
                   color=TEXT_MUTED, ticksuffix="%",
                   title=dict(text="% of imports from top single partner",
                              font=dict(size=11, color=TEXT_MUTED))),
        yaxis=dict(showgrid=False, color=TEXT_MAIN, tickfont=dict(size=11)),
        bargap=0.3,
        updatemenus=[dict(
            type="buttons", showactive=False,
            x=0, y=1.12, xanchor="left",
            buttons=[
                dict(label="▶  Play",
                     method="animate",
                     args=[None, {"frame": {"duration": 800, "redraw": True},
                                  "fromcurrent": True,
                                  "transition": {"duration": 400, "easing": "cubic-in-out"}}]),
                dict(label="⏸  Pause",
                     method="animate",
                     args=[[None], {"frame": {"duration": 0, "redraw": False},
                                    "mode": "immediate",
                                    "transition": {"duration": 0}}]),
            ],
            font=dict(color=TEXT_MAIN, size=12),
            bgcolor=PANEL_BG, bordercolor=BORDER,
        )],
        sliders=[dict(
            active=0, currentvalue={"prefix": "Year: ", "font": {"color": TEXT_MUTED, "size": 12}},
            pad={"t": 10},
            steps=[dict(method="animate", args=[[str(yr)],
                                                {"frame": {"duration": 400, "redraw": True},
                                                 "mode": "immediate",
                                                 "transition": {"duration": 200}}],
                        label=str(yr))
                   for yr in years],
            bgcolor=PANEL_BG, bordercolor=BORDER,
            font=dict(color=TEXT_MUTED, size=10),
        )],
    )

    subtitle = f"{COMMODITIES[commodity]['label']}  ·  colored by zone: 🟢 <33%  🟡 33–66%  🔴 >66%"
    return fig, subtitle


# ── Run ───────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    print(f"\n  Global Trade Explorer  |  available: {', '.join(AVAILABLE)}")
    print("  Open http://127.0.0.1:8050\n")
    app.run(debug=True)
