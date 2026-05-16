"""
Global Trade Explorer — D3.js Backend (Milestone 3)
Flask server that exposes CSV data as JSON APIs consumed by the D3 frontend.

Run:  python app_d3.py
Then: http://127.0.0.1:5000
"""

from pathlib import Path
from flask import Flask, jsonify, send_from_directory
import pandas as pd

# ── Config ────────────────────────────────────────────────────────────────────

DATA_DIR = Path(__file__).parent / "data" / "processed"

COMMODITIES = {
    "energy":    {"label": "Energy",    "hs": "HS 27", "color": "#f97316"},
    "cereals":   {"label": "Cereals",   "hs": "HS 10", "color": "#22c55e"},
    "steel":     {"label": "Steel",     "hs": "HS 72", "color": "#94a3b8"},
    "machinery": {"label": "Machinery", "hs": "HS 84", "color": "#3b82f6"},
    "vehicles":  {"label": "Vehicles",  "hs": "HS 87", "color": "#a855f7"},
}

AGGREGATE_PARTNERS = {
    "World", "Areas, nes", "Special Categories", "Free Zones",
    "Bunkers", "Other Asia, nes", "Unspecified",
}

MOVERS_MIN_TRADE = 500_000_000  # $500M floor

# ── Data loading ──────────────────────────────────────────────────────────────

def load_commodity(cat):
    cs_path = DATA_DIR / f"{cat}_country_summary.csv"
    pf_path = DATA_DIR / f"{cat}_partner_flow.csv"
    if cat == "energy" and not cs_path.exists():
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
        print(f"  OK {cat}")
    else:
        print(f"  -- {cat} (missing)")

AVAILABLE = list(DATA.keys())

# ── Flask app ─────────────────────────────────────────────────────────────────

app = Flask(__name__, static_folder="static", static_url_path="/static")


@app.route("/")
def index():
    return send_from_directory("static", "index.html")


# ── API: metadata ─────────────────────────────────────────────────────────────

@app.route("/api/meta")
def meta():
    first = AVAILABLE[0] if AVAILABLE else "energy"
    years = sorted(
        pd.to_numeric(DATA[first]["cs"]["year"].dropna()).astype(int).unique().tolist()
    )
    commodities = {k: v for k, v in COMMODITIES.items() if k in AVAILABLE}
    return jsonify({
        "commodities": commodities,
        "available": AVAILABLE,
        "years": years,
    })


# ── API: choropleth map data ──────────────────────────────────────────────────

@app.route("/api/map/<commodity>/<int:year>/<flow>")
def map_data(commodity, year, flow):
    if commodity not in DATA:
        return jsonify([])
    cs = DATA[commodity]["cs"]
    subset = cs[cs["year"] == year].copy()
    if flow == "Import":
        val_col = "total_imports"
    elif flow == "Export":
        val_col = "total_exports"
    else:
        val_col = "total_trade"
    if val_col not in subset.columns:
        subset["total_trade"] = subset.get("total_imports", 0) + subset.get("total_exports", 0)
        val_col = "total_trade"
    subset = subset.dropna(subset=["reporter_iso3", val_col])
    subset = subset[subset[val_col] > 0]
    result = subset[["reporter", "reporter_iso3", val_col]].rename(
        columns={val_col: "value"}
    )
    return jsonify(result.to_dict(orient="records"))


# ── API: country summary for side panel ──────────────────────────────────────

@app.route("/api/country/<commodity>/<iso3>/<int:year>")
def country_year(commodity, iso3, year):
    if commodity not in DATA:
        return jsonify({})
    cs = DATA[commodity]["cs"]
    pf = DATA[commodity]["pf"]

    row = cs[(cs["reporter_iso3"] == iso3) & (cs["year"] == year)]
    if row.empty:
        return jsonify({"name": iso3, "year": year, "no_data": True})

    r = row.iloc[0]
    name = r["reporter"]
    total_imp = float(r.get("total_imports", 0) or 0)
    total_exp = float(r.get("total_exports", 0) or 0)

    bilateral = pf[(pf["reporter_iso3"] == iso3) & (pf["year"] == year)]

    def top_partners(flow_label, n=10):
        d = (bilateral[bilateral["flow"] == flow_label]
             .groupby("partner")["trade_value_usd"].sum()
             .sort_values(ascending=False).head(n).reset_index())
        return d.to_dict(orient="records")

    return jsonify({
        "name": name,
        "iso3": iso3,
        "year": year,
        "total_imports": total_imp,
        "total_exports": total_exp,
        "trade_balance": total_exp - total_imp,
        "top_imports": top_partners("Import"),
        "top_exports": top_partners("Export"),
    })


# ── API: time series (trade history) ─────────────────────────────────────────

@app.route("/api/timeseries/<commodity>/<iso3>")
def timeseries(commodity, iso3):
    if commodity not in DATA:
        return jsonify([])
    cs = DATA[commodity]["cs"]
    ts = cs[cs["reporter_iso3"] == iso3].sort_values("year")
    result = ts[["year", "total_imports", "total_exports", "trade_balance"]].copy()
    result["year"] = result["year"].astype(int)
    result = result.fillna(0)
    return jsonify(result.to_dict(orient="records"))


# ── API: Sankey data ──────────────────────────────────────────────────────────

@app.route("/api/sankey/<commodity>/<iso3>/<int:year>")
def sankey(commodity, iso3, year):
    if commodity not in DATA:
        return jsonify({"nodes": [], "links": []})
    pf = DATA[commodity]["pf"]
    bilateral = pf[(pf["reporter_iso3"] == iso3) & (pf["year"] == year)]

    TOP_N = 8
    imp_df = (bilateral[bilateral["flow"] == "Import"]
              .groupby("partner")["trade_value_usd"].sum()
              .sort_values(ascending=False).head(TOP_N).reset_index())
    exp_df = (bilateral[bilateral["flow"] == "Export"]
              .groupby("partner")["trade_value_usd"].sum()
              .sort_values(ascending=False).head(TOP_N).reset_index())

    cs = DATA[commodity]["cs"]
    name_row = cs[(cs["reporter_iso3"] == iso3)]["reporter"]
    center_name = name_row.iloc[0] if not name_row.empty else iso3

    imp_partners = imp_df["partner"].tolist()
    exp_partners = exp_df["partner"].tolist()
    nodes = (
        [{"name": p, "type": "import"} for p in imp_partners]
        + [{"name": center_name, "type": "center"}]
        + [{"name": p, "type": "export"} for p in exp_partners]
    )
    node_idx = {n["name"]: i for i, n in enumerate(nodes)}

    links = []
    for _, row in imp_df.iterrows():
        links.append({
            "source": node_idx[row["partner"]],
            "target": node_idx[center_name],
            "value": float(row["trade_value_usd"]),
            "type": "import",
        })
    for _, row in exp_df.iterrows():
        links.append({
            "source": node_idx[center_name],
            "target": node_idx[row["partner"]],
            "value": float(row["trade_value_usd"]),
            "type": "export",
        })

    return jsonify({"nodes": nodes, "links": links, "center": center_name})


# ── API: import dependency ────────────────────────────────────────────────────

@app.route("/api/dependency/<commodity>/<iso3>")
def dependency(commodity, iso3):
    if commodity not in DATA:
        return jsonify([])
    pf = DATA[commodity]["pf"]
    country_pf = pf[pf["reporter_iso3"] == iso3]
    imp_pf = country_pf[country_pf["flow"] == "Import"]

    rows = []
    for yr in sorted(imp_pf["year"].dropna().unique()):
        yr_data = imp_pf[imp_pf["year"] == yr]
        by_p = yr_data.groupby("partner")["trade_value_usd"].sum().sort_values(ascending=False)
        total = by_p.sum()
        if total <= 0:
            continue
        rows.append({
            "year": int(yr),
            "top1_share": round(float(by_p.iloc[0] / total * 100), 2),
            "top3_share": round(float(by_p.head(3).sum() / total * 100), 2),
            "top1_partner": by_p.index[0],
        })
    return jsonify(rows)


# ── API: top movers ───────────────────────────────────────────────────────────

@app.route("/api/movers/<commodity>/<int:year>/<flow>")
def top_movers(commodity, year, flow):
    if commodity not in DATA or year <= 2000:
        return jsonify([])
    cs = DATA[commodity]["cs"]
    prev = year - 1

    col_map = {"total": "total_trade", "Import": "total_imports", "Export": "total_exports"}
    val_col = col_map.get(flow, "total_trade")

    def get_vals(yr):
        sub = cs[cs["year"] == yr].copy()
        if val_col == "total_trade" and val_col not in sub.columns:
            sub["total_trade"] = sub.get("total_imports", 0) + sub.get("total_exports", 0)
        return sub[["reporter", "reporter_iso3", val_col]].dropna().rename(columns={val_col: "val"})

    cur = get_vals(year).rename(columns={"val": "val_cur"})
    prv = get_vals(prev).rename(columns={"val": "val_prev"})
    merged = cur.merge(prv, on=["reporter", "reporter_iso3"])
    merged = merged[merged["val_prev"] >= MOVERS_MIN_TRADE]
    merged = merged[merged["val_prev"] > 0]
    merged["pct_change"] = (merged["val_cur"] - merged["val_prev"]) / merged["val_prev"] * 100
    merged["abs_change"] = merged["val_cur"] - merged["val_prev"]

    TOP_N = 12
    gainers = merged.nlargest(TOP_N, "pct_change")
    losers  = merged.nsmallest(TOP_N, "pct_change")
    movers  = pd.concat([losers, gainers]).drop_duplicates("reporter").sort_values("pct_change")
    movers  = movers.fillna(0)

    return jsonify(movers[["reporter", "reporter_iso3", "pct_change", "abs_change"]].to_dict(orient="records"))


# ── API: dependency race ──────────────────────────────────────────────────────

@app.route("/api/race/<commodity>")
def race(commodity):
    if commodity not in DATA:
        return jsonify([])
    pf = DATA[commodity]["pf"]
    imp = pf[pf["flow"] == "Import"].copy()

    grp = ["reporter", "reporter_iso3", "year", "partner"]
    by_rpy = imp.groupby(grp, dropna=False)["trade_value_usd"].sum().reset_index()
    id_cols = ["reporter", "reporter_iso3", "year"]
    totals = (by_rpy.groupby(id_cols)["trade_value_usd"].sum()
              .reset_index().rename(columns={"trade_value_usd": "total"}))
    top1 = (by_rpy.sort_values("trade_value_usd", ascending=False)
            .groupby(id_cols).first().reset_index()
            .rename(columns={"trade_value_usd": "top1_val", "partner": "top1_partner"}))

    merged = totals.merge(top1[id_cols + ["top1_val", "top1_partner"]], on=id_cols)
    merged = merged[merged["total"] >= MOVERS_MIN_TRADE]
    merged["top1_share"] = merged["top1_val"] / merged["total"] * 100
    merged["year"] = merged["year"].astype(int)
    merged = merged.round({"top1_share": 2})

    return jsonify(merged[["reporter", "reporter_iso3", "year", "top1_share", "top1_partner", "total"]].to_dict(orient="records"))


# ── Run ───────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    print(f"\n  Global Trade Explorer (D3)  |  available: {', '.join(AVAILABLE)}")
    print("  Open http://127.0.0.1:5000\n")
    app.run(debug=True, port=5000)
