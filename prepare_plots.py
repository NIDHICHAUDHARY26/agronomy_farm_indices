import os, re, sys
import geopandas as gpd
from dotenv import load_dotenv
import config as C

load_dotenv()
path = os.getenv("SHAPEFILE_PATH")
if not path or not os.path.exists(path):
    sys.exit(f"Shapefile not found: {path}")

g = gpd.read_file(path)
print("Rows:", len(g), "| CRS:", g.crs)
if g.crs is None:
    sys.exit("Shapefile has no CRS (.prj missing).")

col = next((c for c in g.columns if c.lower() == "farm"), None)
if col is None:
    sys.exit(f"No 'Farm' column. Columns: {list(g.columns)}")

g = g[[col, "geometry"]].rename(columns={col: "farm"})
g = g.to_crs(4326)

empty = g[g.geometry.isna() | g.geometry.is_empty]
print("Rows with NO polygon:", list(empty["farm"]))
g = g[~(g.geometry.isna() | g.geometry.is_empty)].copy()

g["farm"] = g["farm"].astype(str).str.strip()
bad = g[g["farm"].isin(["", "None", "nan", "NULL"])]
print("Rows with empty Farm value (dropped):", len(bad))
g = g[~g["farm"].isin(["", "None", "nan", "NULL"])].copy()
g["geometry"] = g.geometry.make_valid()

dups = g["farm"][g["farm"].duplicated(keep=False)].unique()
if len(dups):
    print("WARNING duplicate Farm values:", list(dups))

def natkey(s):
    import re as _re
    return [int(t) if t.isdigit() else t.lower() for t in _re.split(r"(\d+)", s)]

order = sorted(range(len(g)), key=lambda i: natkey(g["farm"].iloc[i]))
g = g.iloc[order].reset_index(drop=True)
g["plot_id"] = range(1, len(g) + 1)
g["type"] = g["farm"].apply(lambda s: "farm" if re.match(C.FARM_RE, s) else "place")

utm = g.estimate_utm_crs()
gu = g.to_crs(utm)
g["area_ha"] = (gu.area / 10000).round(4)
buf = gu.geometry.buffer(-C.INNER_BUFFER_M)
g["buffered"] = ~buf.is_empty
gb = gu.copy()
gb["geometry"] = buf.where(~buf.is_empty, gu.geometry)
gb = gb.to_crs(4326)
gb["area_ha"] = g["area_ha"]
gb["buffered"] = g["buffered"]
gb["plot_id"] = g["plot_id"]
gb["type"] = g["type"]

cols = ["plot_id", "farm", "type", "area_ha", "buffered", "geometry"]
g[cols].to_file(C.DATA_DIR / "plots.geojson", driver="GeoJSON")
gb[cols].to_file(C.DATA_DIR / "plots_zonal.geojson", driver="GeoJSON")

print("\nTotal plots:", len(g), "| farms:", (g.type == "farm").sum(), "| places:", (g.type == "place").sum())
print("PLACES:", list(g[g.type == "place"]["farm"]))
print("FARMS :", list(g[g.type == "farm"]["farm"]))
print("Plots too small for inner buffer (full polygon used):", list(g[~g.buffered]["farm"]))
print("Smallest plots (ha):")
print(g.nsmallest(5, "area_ha")[["plot_id", "farm", "area_ha"]].to_string(index=False))
print("\nSaved to", C.DATA_DIR)