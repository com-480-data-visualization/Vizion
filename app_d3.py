"""
Global Trade Explorer — D3.js Backend (Milestone 3)
Serves pre-built JSON data from static/data/ — no pandas at runtime.

Run:  python app_d3.py
Then: http://127.0.0.1:5000
"""

import json
from pathlib import Path
from flask import Flask, jsonify, send_from_directory

STATIC_DIR = Path(__file__).parent / "static"
DATA_DIR   = STATIC_DIR / "data"

# ── Load all pre-built JSON files at startup (~40 MB total) ───────────────────

def load_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)

COMMODITIES = ["energy", "cereals", "steel", "machinery", "vehicles"]

DATA = {}
AVAILABLE = []

print("Loading pre-built JSON data...")
for cat in COMMODITIES:
    try:
        DATA[cat] = {
            "map":    load_json(DATA_DIR / f"{cat}_map.json"),
            "ts":     load_json(DATA_DIR / f"{cat}_ts.json"),
            "panel":  load_json(DATA_DIR / f"{cat}_panel.json"),
            "sankey": load_json(DATA_DIR / f"{cat}_sankey.json"),
            "dep":    load_json(DATA_DIR / f"{cat}_dep.json"),
            "movers": load_json(DATA_DIR / f"{cat}_movers.json"),
            "race":   load_json(DATA_DIR / f"{cat}_race.json"),
        }
        AVAILABLE.append(cat)
        print(f"  OK {cat}")
    except FileNotFoundError:
        print(f"  -- {cat} (missing)")

META = load_json(DATA_DIR / "meta.json")

# ── Flask app ─────────────────────────────────────────────────────────────────

app = Flask(__name__, static_folder="static", static_url_path="/static")


@app.route("/")
def index():
    return send_from_directory("static", "index.html")


# ── API: metadata ─────────────────────────────────────────────────────────────

@app.route("/api/meta")
def meta():
    return jsonify(META)


# ── API: choropleth map ───────────────────────────────────────────────────────

@app.route("/api/map/<commodity>/<int:year>/<flow>")
def map_data(commodity, year, flow):
    if commodity not in DATA:
        return jsonify([])
    year_map = DATA[commodity]["map"].get(flow, {}).get(str(year), [])
    return jsonify([{"reporter": r["n"], "reporter_iso3": r["i"], "value": r["v"]}
                    for r in year_map])


# ── API: country side panel ───────────────────────────────────────────────────

@app.route("/api/country/<commodity>/<iso3>/<int:year>")
def country_year(commodity, iso3, year):
    if commodity not in DATA:
        return jsonify({})
    key = f"{iso3}_{year}"
    p = DATA[commodity]["panel"].get(key)
    if not p:
        return jsonify({"name": iso3, "year": year, "no_data": True})
    return jsonify({
        "name":          p["n"],
        "iso3":          iso3,
        "year":          year,
        "total_imports": p["imp"] or 0,
        "total_exports": p["exp"] or 0,
        "trade_balance": p["bal"] or 0,
        "top_imports":   [{"partner": x["p"], "trade_value_usd": x["v"]} for x in p.get("ti", [])],
        "top_exports":   [{"partner": x["p"], "trade_value_usd": x["v"]} for x in p.get("te", [])],
    })


# ── API: time series ──────────────────────────────────────────────────────────

@app.route("/api/timeseries/<commodity>/<iso3>")
def timeseries(commodity, iso3):
    if commodity not in DATA:
        return jsonify([])
    rows = DATA[commodity]["ts"].get(iso3, [])
    return jsonify([{"year": r["y"], "total_imports": r["imp"] or 0,
                     "total_exports": r["exp"] or 0, "trade_balance": r["bal"] or 0}
                    for r in rows])


# ── API: Sankey ───────────────────────────────────────────────────────────────

@app.route("/api/sankey/<commodity>/<iso3>/<int:year>")
def sankey(commodity, iso3, year):
    if commodity not in DATA:
        return jsonify({"nodes": [], "links": []})
    key = f"{iso3}_{year}"
    s = DATA[commodity]["sankey"].get(key)
    if not s:
        return jsonify({"nodes": [], "links": []})
    links = [{"source": l["s"], "target": l["t"], "value": l["v"], "type": l["type"]}
             for l in s["links"]]
    return jsonify({"nodes": s["nodes"], "links": links, "center": s["center"]})


# ── API: import dependency ────────────────────────────────────────────────────

@app.route("/api/dependency/<commodity>/<iso3>")
def dependency(commodity, iso3):
    if commodity not in DATA:
        return jsonify([])
    rows = DATA[commodity]["dep"].get(iso3, [])
    return jsonify([{"year": r["y"], "top1_share": r["s1"],
                     "top3_share": r["s3"], "top1_partner": r["p1"]}
                    for r in rows])


# ── API: top movers ───────────────────────────────────────────────────────────

@app.route("/api/movers/<commodity>/<int:year>/<flow>")
def top_movers(commodity, year, flow):
    if commodity not in DATA:
        return jsonify([])
    key = f"{year}_{flow}"
    rows = DATA[commodity]["movers"].get(key, [])
    return jsonify([{"reporter": r["n"], "reporter_iso3": r["i"],
                     "pct_change": r["pct"], "abs_change": r["abs"]}
                    for r in rows])


# ── API: dependency race ──────────────────────────────────────────────────────

@app.route("/api/race/<commodity>")
def race(commodity):
    if commodity not in DATA:
        return jsonify([])
    rows = DATA[commodity]["race"]
    return jsonify([{"year": r["y"], "reporter": r["n"], "reporter_iso3": r["i"],
                     "top1_share": r["s"], "top1_partner": r["p"], "total": r["t"]}
                    for r in rows])


# ── Run ───────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    print(f"\n  Global Trade Explorer (D3)  |  available: {', '.join(AVAILABLE)}")
    print("  Open http://127.0.0.1:5000\n")
    app.run(debug=True, port=5000)
