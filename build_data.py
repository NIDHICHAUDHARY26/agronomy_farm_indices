import os, sys, json, time, argparse, calendar
from datetime import date, datetime
import numpy as np
import pandas as pd
import geopandas as gpd
import requests
import ee
from dotenv import load_dotenv
from shapely.geometry import mapping
import config as C

load_dotenv()
D = C.DATA_DIR
GAP_DAYS = getattr(C, "GAPFILL_DAYS", 25)          # search window around a cloudy month
MIN_GAP_CLEAR = getattr(C, "MIN_GAPFILL_CLEAR", 0.30)  # min clear area to accept gap-filled optical


def init_ee():
    project = os.getenv("GOOGLE_EARTH_ENGINE_PROJECT")
    key = (os.getenv("GOOGLE_EARTH_ENGINE_SERVICE_ACCOUNT_KEY") or "").strip()
    if not project or not key:
        sys.exit("Set GOOGLE_EARTH_ENGINE_PROJECT and GOOGLE_EARTH_ENGINE_SERVICE_ACCOUNT_KEY in .env")
    if key.startswith("{"):
        info = json.loads(key)
        creds = ee.ServiceAccountCredentials(info["client_email"], key_data=key)
    else:
        with open(key) as f:
            info = json.load(f)
        creds = ee.ServiceAccountCredentials(info["client_email"], key)
    ee.Initialize(creds, project=project)
    print("Earth Engine connected:", info["client_email"])


def call(fn, tries=3):
    for i in range(tries):
        try:
            return fn()
        except Exception as e:
            if i == tries - 1:
                raise
            print("  retry after error:", str(e)[:120])
            time.sleep(5 * (i + 1))


def month_list(only=None):
    t = date.today()
    ly, lm = (t.year - 1, 12) if t.month == 1 else (t.year, t.month - 1)
    out, y, m = [], C.START_YEAR, C.START_MONTH
    while (y, m) <= (ly, lm):
        out.append((y, m))
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    if only:
        out = [x for x in out if f"{x[0]}-{x[1]:02d}" in only]
    return out


def rng(y, m):
    ny, nm = (y + 1, 1) if m == 12 else (y, m + 1)
    return f"{y}-{m:02d}-01", f"{ny}-{nm:02d}-01"


# ---------- Sentinel-2 ----------
def s2_collection(aoi, start, end):
    return (ee.ImageCollection("COPERNICUS/S2_SR_HARMONIZED")
            .filterBounds(aoi).filterDate(start, end)
            .filter(ee.Filter.lt("CLOUDY_PIXEL_PERCENTAGE", C.MAX_TILE_CLOUD)))


def s2_mask(img):
    ok = img.select("SCL").remap(C.SCL_KEEP, [1] * len(C.SCL_KEEP), 0)
    return (img.select(C.S2_BANDS).updateMask(ok).divide(10000)
            .copyProperties(img, ["system:time_start"]))


def clear_fraction(comp, region):
    v = call(lambda: comp.select("B4").mask().reduceRegion(
        ee.Reducer.mean(), region, 20, maxPixels=1e9, bestEffort=True).get("B4").getInfo())
    return float(v or 0)


def s2_composite(aoi, region, start, end):
    """Normal monthly median composite."""
    col = s2_collection(aoi, start, end)
    n = call(lambda: col.size().getInfo())
    if n == 0:
        return None, 0, 0.0
    comp = col.map(s2_mask).median()
    return comp, n, clear_fraction(comp, region)


def s2_nearest(aoi, region, start, end, days):
    """Gap-fill: for every pixel take the clear observation closest in time
    to the middle of the month, searching +/- `days` around the month."""
    d0 = ee.Date(start)
    mid = d0.advance(15, "day").millis()
    col = s2_collection(aoi, d0.advance(-days, "day"), ee.Date(end).advance(days, "day"))
    n = call(lambda: col.size().getInfo())
    if n == 0:
        return None, 0, 0.0

    def prep(img):
        img = ee.Image(img)
        m = ee.Image(s2_mask(img))
        dt = ee.Number(img.get("system:time_start")).subtract(mid).abs().divide(86400000)
        score = (ee.Image.constant(dt).multiply(-1).toFloat()
                 .updateMask(m.select("B4").mask()).rename("score"))
        return m.addBands(score)

    comp = col.map(prep).qualityMosaic("score").select(C.S2_BANDS)
    return comp, n, clear_fraction(comp, region)


def s2_index_image(comp):
    bands = {b: comp.select(b) for b in C.S2_BANDS}
    imgs = [comp.expression(s["expr"], bands).rename(n)
            for n, s in C.INDICES.items() if s["sensor"] == "S2"]
    return ee.Image.cat(imgs)


# ---------- Sentinel-1 ----------
def s1_image(aoi, start, end):
    col = (ee.ImageCollection("COPERNICUS/S1_GRD").filterBounds(aoi).filterDate(start, end)
           .filter(ee.Filter.eq("instrumentMode", "IW"))
           .filter(ee.Filter.listContains("transmitterReceiverPolarisation", "VV"))
           .filter(ee.Filter.listContains("transmitterReceiverPolarisation", "VH")))
    n = call(lambda: col.size().getInfo())
    if n == 0:
        return None, 0

    def to_lin(i):
        return (i.select(["VV", "VH"]).divide(10).multiply(2.302585093).exp()
                .copyProperties(i, ["system:time_start"]))

    lin = col.map(to_lin).mean()
    vv, vh = lin.select("VV"), lin.select("VH")
    vv_db = vv.log10().multiply(10)
    vh_db = vh.log10().multiply(10)
    out = ee.Image.cat([
        vv_db.rename("VV"), vh_db.rename("VH"),
        vh_db.subtract(vv_db).rename("VH_VV"),
        vh.multiply(4).divide(vv.add(vh)).rename("RVI"),
    ])
    return out, n


# ---------- Landsat LST ----------
def lst_image(aoi, start, end):
    def prep(i):
        m = i.select("QA_PIXEL").bitwiseAnd(30).eq(0)
        t = i.select("ST_B10").multiply(0.00341802).add(149.0).subtract(273.15)
        return t.updateMask(m).rename("LST").copyProperties(i, ["system:time_start"])

    col = (ee.ImageCollection("LANDSAT/LC08/C02/T1_L2")
           .merge(ee.ImageCollection("LANDSAT/LC09/C02/T1_L2"))
           .filterBounds(aoi).filterDate(start, end))
    n = call(lambda: col.size().getInfo())
    if n == 0:
        return None, 0
    return col.map(prep).median(), n


# ---------- zonal statistics ----------
def zonal_rows(img, fc, scale, sensor, month, mode):
    bands = call(lambda: img.bandNames().getInfo())
    red = (ee.Reducer.mean()
           .combine(ee.Reducer.min(), "", True)
           .combine(ee.Reducer.max(), "", True)
           .combine(ee.Reducer.stdDev(), "", True)
           .combine(ee.Reducer.count(), "", True))
    reduced = img.reduceRegions(collection=fc, reducer=red, scale=scale, tileScale=4)
    res = call(lambda: reduced.map(lambda f: ee.Feature(None, f.toDictionary())).getInfo())
    single = len(bands) == 1
    rows = []
    for f in res["features"]:
        p = f["properties"]
        for b in bands:
            def g(s, b=b):
                return p.get(s if single else f"{b}_{s}")
            rows.append(dict(month=month, plot_id=p["plot_id"], index=b,
                             mean=g("mean"), min=g("min"), max=g("max"),
                             std=g("stdDev"), pixels=g("count"),
                             sensor=sensor, mode=mode))
    return rows


def process_month(fc, aoi, region, y, m):
    key = f"{y}-{m:02d}"
    start, end = rng(y, m)

    comp, n_s2, clear = s2_composite(aoi, region, start, end)
    mode, gap_clear = "radar_only", None
    if comp is not None and clear >= C.MIN_CLEAR_FRACTION:
        mode = "optical"
    else:
        comp2, n_gap, gap_clear = s2_nearest(aoi, region, start, end, GAP_DAYS)
        if comp2 is not None and gap_clear >= MIN_GAP_CLEAR:
            comp, mode = comp2, "gapfill"

    msg = f"{key}: S2 images={n_s2}, clear={clear:.0%}"
    if gap_clear is not None:
        msg += f", gap-fill clear={gap_clear:.0%}"
    print(msg, "->", mode)

    rows = []
    if mode in ("optical", "gapfill"):
        img = s2_index_image(comp)
        for res in (10, 20):
            names = [n for n, s in C.INDICES.items() if s["sensor"] == "S2" and s["res"] == res]
            if names:
                rows += zonal_rows(img.select(names), fc, res, "S2", key, mode)
    s1, n_s1 = s1_image(aoi, start, end)
    if s1 is not None:
        rows += zonal_rows(s1, fc, 10, "S1", key, mode)
    ls, n_ls = lst_image(aoi, start, end)
    if ls is not None:
        rows += zonal_rows(ls, fc, 30, "LANDSAT", key, mode)
    print(f"   S1 images={n_s1}, Landsat images={n_ls}, rows={len(rows)}")
    info = dict(mode=mode, clear_fraction=round(clear, 3),
                gapfill_clear_fraction=None if gap_clear is None else round(gap_clear, 3),
                s2_images=n_s2, s1_images=n_s1, landsat_images=n_ls)
    return rows, info


# ---------- weather (optional, off by default) ----------
def build_weather(months, plots):
    first = f"{months[0][0]}-{months[0][1]:02d}-01"
    ly, lm = months[-1]
    last = f"{ly}-{lm:02d}-{calendar.monthrange(ly, lm)[1]}"
    pu = plots.to_crs(plots.estimate_utm_crs())
    c = pu.geometry.representative_point().to_crs(4326)
    plots = plots.copy()
    plots["cell_lat"] = c.y.round(1).values
    plots["cell_lon"] = c.x.round(1).values
    plots["cell_id"] = plots["cell_lat"].astype(str) + "_" + plots["cell_lon"].astype(str)

    vars_ = ["temperature_2m_max", "temperature_2m_min", "temperature_2m_mean",
             "precipitation_sum", "et0_fao_evapotranspiration",
             "shortwave_radiation_sum", "wind_speed_10m_max"]
    frames = []
    for cid, grp in plots.groupby("cell_id"):
        r = requests.get("https://archive-api.open-meteo.com/v1/archive", params=dict(
            latitude=grp.cell_lat.iloc[0], longitude=grp.cell_lon.iloc[0],
            start_date=first, end_date=last, daily=",".join(vars_),
            timezone="Asia/Kolkata"), timeout=90)
        r.raise_for_status()
        d = pd.DataFrame(r.json()["daily"])
        d["cell_id"] = cid
        frames.append(d)
    daily = pd.concat(frames).rename(columns={"time": "date"})
    daily["month"] = daily["date"].str[:7]
    daily["gdd10"] = (((daily.temperature_2m_max + daily.temperature_2m_min) / 2) - 10).clip(lower=0)
    monthly = daily.groupby(["cell_id", "month"]).agg(
        tmax_mean=("temperature_2m_max", "mean"),
        tmin_mean=("temperature_2m_min", "mean"),
        tmean=("temperature_2m_mean", "mean"),
        rain_mm=("precipitation_sum", "sum"),
        rainy_days=("precipitation_sum", lambda s: int((s >= 1).sum())),
        et0_mm=("et0_fao_evapotranspiration", "sum"),
        solar_MJ_m2=("shortwave_radiation_sum", "sum"),
        wind_max_kmh=("wind_speed_10m_max", "mean"),
        gdd10=("gdd10", "sum")).reset_index().round(2)
    mp = plots[["plot_id", "farm", "type", "cell_id"]].merge(monthly, on="cell_id")
    mp.sort_values(["month", "plot_id"]).to_csv(D / "weather_monthly.csv", index=False)
    daily.round(2).to_csv(D / "weather_daily.csv", index=False)
    print(f"Weather saved: {plots.cell_id.nunique()} grid cell(s) cover {len(plots)} plots")


# ---------- main ----------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true", help="recompute all months")
    ap.add_argument("--only", help="recompute only these months, e.g. 2026-03,2026-04")
    ap.add_argument("--weather", action="store_true", help="also build weather files (off by default)")
    ap.add_argument("--skip-weather", action="store_true", help="kept for old commands; weather is off by default")
    a = ap.parse_args()

    init_ee()
    plots = gpd.read_file(D / "plots.geojson")
    gz = gpd.read_file(D / "plots_zonal.geojson")
    fc = ee.FeatureCollection([
        ee.Feature(ee.Geometry(mapping(r.geometry), None, False), {"plot_id": int(r.plot_id)})
        for r in gz.itertuples()])
    region = fc.geometry()
    aoi = region.bounds()

    zs_path, meta_path = D / "zonal_stats.csv", D / "meta.json"
    old = pd.read_csv(zs_path) if zs_path.exists() else pd.DataFrame()
    if not old.empty:
        old = old[old["index"] != "SoilWetness_rel"]
    meta = json.load(open(meta_path)) if meta_path.exists() else {"months": {}}

    only = a.only.split(",") if a.only else None
    months = month_list(only)
    if a.force:
        old, meta["months"] = pd.DataFrame(), {}
        todo = months
    elif only:
        old = old[~old["month"].isin(only)] if not old.empty else old
        todo = months
    else:
        done = set(old["month"].unique()) if not old.empty else set()
        todo = [mo for mo in months if f"{mo[0]}-{mo[1]:02d}" not in done]

    print("Months to process:", [f"{y}-{m:02d}" for y, m in todo] or "none (already up to date)")
    new_rows = []
    for y, m in todo:
        rows, info = process_month(fc, aoi, region, y, m)
        new_rows += rows
        meta["months"][f"{y}-{m:02d}"] = info

    df = pd.concat([old, pd.DataFrame(new_rows)], ignore_index=True)
    if not df.empty:
        df = df.drop(columns=["farm", "type"], errors="ignore").merge(
            plots[["plot_id", "farm", "type"]], on="plot_id", how="left")
        df = df.replace([np.inf, -np.inf], np.nan)

        vv = df[df["index"] == "VV"].copy()
        if not vv.empty:
            gp = vv.groupby("plot_id")["mean"]
            span = (gp.transform("max") - gp.transform("min")).replace(0, np.nan)
            vv["mean"] = (vv["mean"] - gp.transform("min")) / span
            vv["index"] = "SoilWetness_rel"
            vv[["min", "max", "std"]] = np.nan
            vv["sensor"] = "DERIVED"
            df = pd.concat([df, vv], ignore_index=True)

        order = ["month", "plot_id", "farm", "type", "index", "mean", "min", "max",
                 "std", "pixels", "sensor", "mode"]
        df = df[order].sort_values(["month", "plot_id", "index"]).round(5)
        df.to_csv(zs_path, index=False)
        print("Saved", zs_path, "rows:", len(df))

    meta["months"] = dict(sorted(meta["months"].items()))
    meta["generated_at"] = datetime.now().isoformat(timespec="seconds")
    meta["min_clear_fraction"] = C.MIN_CLEAR_FRACTION
    meta["gapfill_days"] = GAP_DAYS
    meta["indices"] = [dict(name=n, label=s["label"] or n, group=s["group"],
                            sensor=s["sensor"], res=s["res"], range=list(s["range"]))
                       for n, s in C.INDICES.items()]
    json.dump(meta, open(meta_path, "w"), indent=2)

    if a.weather and months:
        build_weather(month_list(), plots)
    print("Done.")


if __name__ == "__main__":
    main()