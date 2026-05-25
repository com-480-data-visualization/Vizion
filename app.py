"""
Global Trade Explorer — D3.js Backend (Milestone 3)
Serves pre-built JSON data from static/data/ — no pandas at runtime.

Production: gunicorn app:server
Dev:        python app.py  →  http://127.0.0.1:5000
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

# ── Flask app — variable MUST be named 'server' for gunicorn app:server ───────

server = Flask(__name__, static_folder="static", static_url_path="/static")


@server.route("/")
def index():
    return send_from_directory("static", "index.html")


# ── API: metadata ─────────────────────────────────────────────────────────────

@server.route("/api/meta")
def meta():
    return jsonify(META)


# ── API: choropleth map ───────────────────────────────────────────────────────

@server.route("/api/map/<commodity>/<int:year>/<flow>")
def map_data(commodity, year, flow):
    if commodity not in DATA:
        return jsonify([])
    year_map = DATA[commodity]["map"].get(flow, {}).get(str(year), [])
    return jsonify([{"reporter": r["n"], "reporter_iso3": r["i"], "value": r["v"]}
                    for r in year_map])


# ── API: country side panel ───────────────────────────────────────────────────

@server.route("/api/country/<commodity>/<iso3>/<int:year>")
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

@server.route("/api/timeseries/<commodity>/<iso3>")
def timeseries(commodity, iso3):
    if commodity not in DATA:
        return jsonify([])
    rows = DATA[commodity]["ts"].get(iso3, [])
    return jsonify([{"year": r["y"], "total_imports": r["imp"] or 0,
                     "total_exports": r["exp"] or 0, "trade_balance": r["bal"] or 0}
                    for r in rows])


# ── API: Sankey ───────────────────────────────────────────────────────────────

@server.route("/api/sankey/<commodity>/<iso3>/<int:year>")
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

@server.route("/api/dependency/<commodity>/<iso3>")
def dependency(commodity, iso3):
    if commodity not in DATA:
        return jsonify([])
    rows = DATA[commodity]["dep"].get(iso3, [])
    return jsonify([{"year": r["y"], "top1_share": r["s1"],
                     "top3_share": r["s3"], "top1_partner": r["p1"]}
                    for r in rows])


# ── API: top movers ───────────────────────────────────────────────────────────

@server.route("/api/movers/<commodity>/<int:year>/<flow>")
def top_movers(commodity, year, flow):
    if commodity not in DATA:
        return jsonify([])
    key = f"{year}_{flow}"
    rows = DATA[commodity]["movers"].get(key, [])
    return jsonify([{"reporter": r["n"], "reporter_iso3": r["i"],
                     "pct_change": r["pct"], "abs_change": r["abs"]}
                    for r in rows])


# ── API: dependency race ──────────────────────────────────────────────────────

@server.route("/api/race/<commodity>")
def race(commodity):
    if commodity not in DATA:
        return jsonify([])
    rows = DATA[commodity]["race"]
    return jsonify([{"year": r["y"], "reporter": r["n"], "reporter_iso3": r["i"],
                     "top1_share": r["s"], "top1_partner": r["p"], "total": r["t"]}
                    for r in rows])


# ── API: disruption — who depends on a given partner? ────────────────────────

@server.route("/api/disruption/<commodity>/<partner>/<int:year>")
def disruption_data(commodity, partner, year):
    """Who depends on <partner> as an import source? (partner removed as exporter)"""
    if commodity not in DATA:
        return jsonify([])
    panel = DATA[commodity]["panel"]
    suffix = f"_{year}"
    result = []
    for key, val in panel.items():
        if not key.endswith(suffix):
            continue
        iso3 = key[: -len(suffix)]
        total = val.get("imp") or 0
        if total <= 0:
            continue
        pval = next((x["v"] for x in val.get("ti", []) if x["p"] == partner), None)
        if pval is None:
            continue
        result.append({"iso3": iso3, "name": val["n"], "share": round(pval / total * 100, 2)})
    result.sort(key=lambda x: -x["share"])
    return jsonify(result)


@server.route("/api/disruption_import/<commodity>/<buyer>/<int:year>")
def disruption_import(commodity, buyer, year):
    """Who depends on <buyer> as an export destination? (buyer removed as importer)"""
    if commodity not in DATA:
        return jsonify([])
    panel = DATA[commodity]["panel"]
    suffix = f"_{year}"
    result = []
    for key, val in panel.items():
        if not key.endswith(suffix):
            continue
        iso3 = key[: -len(suffix)]
        total = val.get("exp") or 0
        if total <= 0:
            continue
        pval = next((x["v"] for x in val.get("te", []) if x["p"] == buyer), None)
        if pval is None:
            continue
        result.append({"iso3": iso3, "name": val["n"], "share": round(pval / total * 100, 2)})
    result.sort(key=lambda x: -x["share"])
    return jsonify(result)


# ── API: trade blocs — share of imports from two anchor countries ─────────────

@server.route("/api/bloc/<commodity>/<iso_a>/<iso_b>/<int:year>")
def bloc_data(commodity, iso_a, iso_b, year):
    if commodity not in DATA:
        return jsonify([])
    panel = DATA[commodity]["panel"]
    entry_a = panel.get(f"{iso_a}_{year}")
    entry_b = panel.get(f"{iso_b}_{year}")
    if not entry_a or not entry_b:
        return jsonify([])
    name_a = entry_a["n"]
    name_b = entry_b["n"]
    result = []
    for key, val in panel.items():
        parts = key.rsplit("_", 1)
        if len(parts) != 2 or parts[1] != str(year):
            continue
        iso3 = parts[0]
        if iso3 in (iso_a, iso_b):
            continue
        total = val.get("imp") or 0
        if total <= 0:
            continue
        ti = val.get("ti", [])
        share_a = next((x["v"] / total * 100 for x in ti if x["p"] == name_a), 0)
        share_b = next((x["v"] / total * 100 for x in ti if x["p"] == name_b), 0)
        if share_a == 0 and share_b == 0:
            continue
        result.append({
            "iso3": iso3, "name": val["n"],
            "share_a": round(share_a, 2),
            "share_b": round(share_b, 2),
            "total_imp": total,
        })
    return jsonify(result)


# ── Run ───────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    print(f"\n  Global Trade Explorer (D3)  |  available: {', '.join(AVAILABLE)}")
    print("  Open http://127.0.0.1:5000\n")
    server.run(debug=True, port=5000)
