"""
build_data.py — one-time data pipeline for the D3 frontend.

Reads data/processed/*.csv and writes pre-aggregated JSON to static/data/.
Run once (or after re-downloading Comtrade data):
    python build_data.py
"""

import json, math
from pathlib import Path
import pandas as pd
import numpy as np

# ── Config ────────────────────────────────────────────────────────────────────

DATA_DIR   = Path("data/processed")
OUT_DIR    = Path("static/data")
OUT_DIR.mkdir(parents=True, exist_ok=True)

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

MOVERS_MIN_TRADE = 500_000_000
TOP_PARTNERS     = 10
SANKEY_N         = 8
RACE_N           = 15


def clean(v):
    """Replace NaN/Inf with None for JSON safety."""
    if v is None:
        return None
    try:
        if math.isnan(v) or math.isinf(v):
            return None
        return round(float(v), 2)
    except Exception:
        return v


def write_json(path: Path, obj):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, separators=(",", ":"), ensure_ascii=False)
    kb = path.stat().st_size / 1024
    print(f"    wrote {path.name}  ({kb:.0f} KB)")


# ── Load commodity ────────────────────────────────────────────────────────────

def load(cat):
    cs_path = DATA_DIR / f"{cat}_country_summary.csv"
    pf_path = DATA_DIR / f"{cat}_partner_flow.csv"
    if cat == "energy" and not cs_path.exists():
        cs_path = DATA_DIR / "country_summary.csv"
        pf_path = DATA_DIR / "partner_summary.csv"
    if not cs_path.exists() or not pf_path.exists():
        return None, None

    cs = pd.read_csv(cs_path)
    pf = pd.read_csv(pf_path)
    for df in (cs, pf):
        df["year"] = pd.to_numeric(df["year"], errors="coerce").astype("Int64")
    pf = pf[~pf["partner"].isin(AGGREGATE_PARTNERS)]
    return cs, pf


# ── Build map data ────────────────────────────────────────────────────────────

def build_map(cs):
    """
    Returns {flow: {year: [{reporter, reporter_iso3, value}]}}
    Flows: total, Import, Export
    """
    result = {}
    years = sorted(cs["year"].dropna().unique().astype(int).tolist())

    for flow, col in [("total", "total_trade"), ("Import", "total_imports"), ("Export", "total_exports")]:
        flow_years = {}
        for yr in years:
            sub = cs[cs["year"] == yr].copy()
            if col not in sub.columns:
                sub["total_trade"] = sub.get("total_imports", pd.Series(0, index=sub.index)) + \
                                     sub.get("total_exports", pd.Series(0, index=sub.index))
                col_use = "total_trade"
            else:
                col_use = col
            sub = sub.dropna(subset=["reporter_iso3", col_use])
            sub = sub[sub[col_use] > 0]
            rows = []
            for _, r in sub.iterrows():
                rows.append({
                    "n": r["reporter"],
                    "i": r["reporter_iso3"],
                    "v": clean(r[col_use]),
                })
            flow_years[str(yr)] = rows
        result[flow] = flow_years

    return result


# ── Build time-series ─────────────────────────────────────────────────────────

def build_timeseries(cs):
    """
    Returns {iso3: [{y, imp, exp, bal}]}
    """
    result = {}
    for iso3, grp in cs.groupby("reporter_iso3"):
        grp = grp.sort_values("year")
        rows = []
        for _, r in grp.iterrows():
            rows.append({
                "y":   int(r["year"]),
                "imp": clean(r.get("total_imports", 0)),
                "exp": clean(r.get("total_exports", 0)),
                "bal": clean(r.get("trade_balance", 0)),
            })
        result[str(iso3)] = rows
    return result


# ── Build per-country-per-year panel data ─────────────────────────────────────

def build_panel(cs, pf):
    """
    Returns {"ISO3_YEAR": {imp, exp, bal, top_imp:[{p,v}], top_exp:[{p,v}]}}
    """
    result = {}
    years = sorted(cs["year"].dropna().unique().astype(int).tolist())

    for iso3, cs_grp in cs.groupby("reporter_iso3"):
        pf_country = pf[pf["reporter_iso3"] == iso3] if "reporter_iso3" in pf.columns else pd.DataFrame()
        iso3 = str(iso3)

        for yr in years:
            row = cs_grp[cs_grp["year"] == yr]
            if row.empty:
                continue
            r = row.iloc[0]

            imp = float(r.get("total_imports", 0) or 0)
            exp = float(r.get("total_exports", 0) or 0)

            bil = pf_country[pf_country["year"] == yr] if not pf_country.empty else pd.DataFrame()

            def top_p(flow, n=TOP_PARTNERS):
                if bil.empty:
                    return []
                d = (bil[bil["flow"] == flow]
                     .groupby("partner")["trade_value_usd"].sum()
                     .sort_values(ascending=False).head(n))
                return [{"p": str(k), "v": clean(v)} for k, v in d.items()]

            result[f"{iso3}_{yr}"] = {
                "n":   str(r["reporter"]),
                "imp": clean(imp),
                "exp": clean(exp),
                "bal": clean(exp - imp),
                "ti":  top_p("Import"),
                "te":  top_p("Export"),
            }

    return result


# ── Build Sankey data ─────────────────────────────────────────────────────────

def build_sankey(cs, pf):
    """
    Returns {"ISO3_YEAR": {nodes:[{name,type}], links:[{s,t,v,type}], center}}
    """
    result = {}
    years = sorted(pf["year"].dropna().unique().astype(int).tolist())

    name_map = cs.drop_duplicates("reporter_iso3").set_index("reporter_iso3")["reporter"].to_dict()

    for iso3, pf_grp in pf.groupby("reporter_iso3"):
        iso3 = str(iso3)
        center_name = name_map.get(iso3, iso3)

        for yr in years:
            bil = pf_grp[pf_grp["year"] == yr]
            if bil.empty:
                continue

            imp_df = (bil[bil["flow"] == "Import"]
                      .groupby("partner")["trade_value_usd"].sum()
                      .sort_values(ascending=False).head(SANKEY_N))
            exp_df = (bil[bil["flow"] == "Export"]
                      .groupby("partner")["trade_value_usd"].sum()
                      .sort_values(ascending=False).head(SANKEY_N))

            if imp_df.empty and exp_df.empty:
                continue

            imp_partners = list(imp_df.index)
            exp_partners = list(exp_df.index)

            nodes = (
                [{"name": p, "type": "import"} for p in imp_partners]
                + [{"name": center_name, "type": "center"}]
                + [{"name": p, "type": "export"} for p in exp_partners]
            )
            node_idx = {n["name"]: i for i, n in enumerate(nodes)}
            center_idx = node_idx[center_name]

            links = []
            for p, v in imp_df.items():
                links.append({"s": node_idx[p], "t": center_idx, "v": clean(v), "type": "import"})
            for p, v in exp_df.items():
                links.append({"s": center_idx, "t": node_idx[p], "v": clean(v), "type": "export"})

            result[f"{iso3}_{yr}"] = {
                "nodes":  nodes,
                "links":  links,
                "center": center_name,
            }

    return result


# ── Build dependency data ─────────────────────────────────────────────────────

def build_dependency(pf):
    """
    Returns {iso3: [{y, s1, s3, p1}]}
    s1 = top-1 share %, s3 = top-3 share %, p1 = top partner name
    """
    result = {}
    imp = pf[pf["flow"] == "Import"]

    for iso3, grp in imp.groupby("reporter_iso3"):
        rows = []
        for yr in sorted(grp["year"].dropna().unique()):
            by_p = grp[grp["year"] == yr].groupby("partner")["trade_value_usd"].sum().sort_values(ascending=False)
            total = by_p.sum()
            if total <= 0:
                continue
            rows.append({
                "y":  int(yr),
                "s1": clean(by_p.iloc[0] / total * 100),
                "s3": clean(by_p.head(3).sum() / total * 100),
                "p1": str(by_p.index[0]),
            })
        if rows:
            result[str(iso3)] = rows

    return result


# ── Build top movers ──────────────────────────────────────────────────────────

def build_movers(cs):
    """
    Returns {"YEAR_flow": [{reporter, iso3, pct, abs}]}
    """
    result = {}
    years = sorted(cs["year"].dropna().unique().astype(int).tolist())
    col_map = {"total": "total_trade", "Import": "total_imports", "Export": "total_exports"}

    for flow, col in col_map.items():
        for yr in years:
            if yr <= years[0]:
                continue
            prev = yr - 1

            def get_vals(y):
                sub = cs[cs["year"] == y].copy()
                if col == "total_trade" and col not in sub.columns:
                    sub["total_trade"] = (
                        sub.get("total_imports", pd.Series(0, index=sub.index)) +
                        sub.get("total_exports", pd.Series(0, index=sub.index))
                    )
                if col not in sub.columns:
                    return pd.DataFrame()
                return sub[["reporter", "reporter_iso3", col]].dropna().rename(columns={col: "val"})

            cur  = get_vals(yr).rename(columns={"val": "val_cur"})
            prv  = get_vals(prev).rename(columns={"val": "val_prev"})
            if cur.empty or prv.empty:
                continue

            merged = cur.merge(prv, on=["reporter", "reporter_iso3"])
            merged = merged[merged["val_prev"] >= MOVERS_MIN_TRADE]
            merged = merged[merged["val_prev"] > 0]
            if merged.empty:
                continue

            merged["pct"] = (merged["val_cur"] - merged["val_prev"]) / merged["val_prev"] * 100
            merged["abs"] = merged["val_cur"] - merged["val_prev"]

            TOP_N = 12
            gainers = merged.nlargest(TOP_N, "pct")
            losers  = merged.nsmallest(TOP_N, "pct")
            movers  = pd.concat([losers, gainers]).drop_duplicates("reporter").sort_values("pct")

            rows = []
            for _, r in movers.iterrows():
                rows.append({
                    "n":   str(r["reporter"]),
                    "i":   str(r["reporter_iso3"]),
                    "pct": clean(r["pct"]),
                    "abs": clean(r["abs"]),
                })
            result[f"{yr}_{flow}"] = rows

    return result


# ── Build dependency race ─────────────────────────────────────────────────────

def build_race(pf):
    """
    Returns [{y, n, i, s, p, t}]  (year, name, iso3, share, top_partner, total)
    """
    imp = pf[pf["flow"] == "Import"].copy()
    grp_cols = [c for c in ["reporter", "reporter_iso3", "year", "partner"] if c in imp.columns]
    by_rpy = imp.groupby(grp_cols, dropna=False)["trade_value_usd"].sum().reset_index()

    id_cols = [c for c in ["reporter", "reporter_iso3", "year"] if c in by_rpy.columns]
    totals = (by_rpy.groupby(id_cols)["trade_value_usd"].sum()
              .reset_index().rename(columns={"trade_value_usd": "total"}))
    top1 = (by_rpy.sort_values("trade_value_usd", ascending=False)
            .groupby(id_cols).first().reset_index()
            .rename(columns={"trade_value_usd": "top1_val", "partner": "top1_partner"}))

    merged = totals.merge(top1[id_cols + ["top1_val", "top1_partner"]], on=id_cols)
    merged = merged[merged["total"] >= MOVERS_MIN_TRADE]
    merged["share"] = merged["top1_val"] / merged["total"] * 100
    merged["year"]  = merged["year"].astype(int)

    rows = []
    for _, r in merged.iterrows():
        rows.append({
            "y": int(r["year"]),
            "n": str(r["reporter"]),
            "i": str(r["reporter_iso3"]),
            "s": clean(r["share"]),
            "p": str(r["top1_partner"]),
            "t": clean(r["total"]),
        })
    return rows


# ── Meta ──────────────────────────────────────────────────────────────────────

def build_meta(available, cs_ref):
    years = sorted(cs_ref["year"].dropna().unique().astype(int).tolist())
    countries = (cs_ref[["reporter", "reporter_iso3"]].drop_duplicates().dropna()
                 .sort_values("reporter")
                 .rename(columns={"reporter": "name", "reporter_iso3": "iso3"})
                 .to_dict(orient="records"))
    return {
        "commodities": {k: v for k, v in COMMODITIES.items() if k in available},
        "available":   available,
        "years":       years,
        "countries":   countries,
    }


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    available = []
    ref_cs    = None

    for cat in COMMODITIES:
        print(f"\n[{cat}]")
        cs, pf = load(cat)
        if cs is None:
            print("  skipped (missing files)")
            continue

        available.append(cat)
        if ref_cs is None:
            ref_cs = cs

        write_json(OUT_DIR / f"{cat}_map.json",  build_map(cs))
        write_json(OUT_DIR / f"{cat}_ts.json",   build_timeseries(cs))
        write_json(OUT_DIR / f"{cat}_panel.json", build_panel(cs, pf))
        write_json(OUT_DIR / f"{cat}_sankey.json", build_sankey(cs, pf))
        write_json(OUT_DIR / f"{cat}_dep.json",   build_dependency(pf))
        write_json(OUT_DIR / f"{cat}_movers.json", build_movers(cs))
        write_json(OUT_DIR / f"{cat}_race.json",   build_race(pf))

    if ref_cs is not None:
        write_json(OUT_DIR / "meta.json", build_meta(available, ref_cs))

    print(f"\nDone. {len(list(OUT_DIR.iterdir()))} files in {OUT_DIR}/")
    print("Serve with:  python -m http.server 5000 --directory static")
    print("Then open:   http://localhost:5000")


if __name__ == "__main__":
    main()
