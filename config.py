from pathlib import Path

DATA_DIR = Path(__file__).parent / "data"
DATA_DIR.mkdir(exist_ok=True)

START_YEAR, START_MONTH = 2026, 1
MIN_CLEAR_FRACTION = 0.60   # below this clear-area share, month = radar only
MAX_TILE_CLOUD = 80         # skip Sentinel-2 images with more cloud than this (%)
SCL_KEEP = [4, 5, 6]        # vegetation, bare soil, water
INNER_BUFFER_M = 10         # shrink each plot inward to avoid edge pixels

S2_BANDS = ["B2", "B3", "B4", "B5", "B6", "B7", "B8", "B8A", "B11", "B12"]

FARM_RE = r"^\d+\s*-?\s*[A-Za-z]?$"   # 1, 10, 30-A, 30B = farm; anything else = place

def I(expr, sensor, res, group, rng, label=None):
    return dict(expr=expr, sensor=sensor, res=res, group=group, range=rng, label=label)

INDICES = {
    # Vegetation (10 m)
    "NDVI":   I("(B8-B4)/(B8+B4)", "S2", 10, "Vegetation", (-0.1, 0.9)),
    "EVI":    I("2.5*(B8-B4)/(B8+6*B4-7.5*B2+1)", "S2", 10, "Vegetation", (-0.1, 1.0)),
    "SAVI":   I("1.5*(B8-B4)/(B8+B4+0.5)", "S2", 10, "Vegetation", (-0.1, 0.9)),
    "OSAVI":  I("(B8-B4)/(B8+B4+0.16)", "S2", 10, "Vegetation", (-0.1, 0.9)),
    "MSAVI2": I("(2*B8+1-sqrt((2*B8+1)**2-8*(B8-B4)))/2", "S2", 10, "Vegetation", (-0.1, 0.9)),
    "GNDVI":  I("(B8-B3)/(B8+B3)", "S2", 10, "Vegetation", (-0.1, 0.9)),
    "ARVI":   I("(B8-(2*B4-B2))/(B8+(2*B4-B2))", "S2", 10, "Vegetation", (-0.1, 0.9)),
    "CIgreen": I("B8/B3-1", "S2", 10, "Vegetation", (0, 6)),
    # Chlorophyll / maturity (20 m)
    "NDRE":    I("(B8A-B5)/(B8A+B5)", "S2", 20, "Chlorophyll", (-0.1, 0.6)),
    "CIre":    I("B7/B5-1", "S2", 20, "Chlorophyll", (0, 8)),
    "MTCI":    I("(B6-B5)/(B5-B4)", "S2", 20, "Chlorophyll", (0, 5)),
    "NDVI705": I("(B6-B5)/(B6+B5)", "S2", 20, "Chlorophyll", (-0.1, 0.6)),
    "PSRI":    I("(B4-B2)/B6", "S2", 20, "Chlorophyll", (-0.2, 0.5)),
    # Water / moisture
    "NDWI":  I("(B3-B8)/(B3+B8)", "S2", 10, "Water", (-0.6, 0.4)),
    "MNDWI": I("(B3-B11)/(B3+B11)", "S2", 20, "Water", (-0.6, 0.4)),
    "NDMI":  I("(B8-B11)/(B8+B11)", "S2", 20, "Water", (-0.4, 0.6)),
    # Soil (BSI, NDTI, ClayRatio = 20 m, SI = 10 m)
    "BSI":       I("((B11+B4)-(B8+B2))/((B11+B4)+(B8+B2))", "S2", 20, "Soil", (-0.5, 0.5)),
    "NDTI":      I("(B11-B12)/(B11+B12)", "S2", 20, "Soil", (-0.1, 0.4)),
    "SI":        I("sqrt(B3*B4)", "S2", 10, "Soil", (0, 0.4)),
    "ClayRatio": I("B11/B12", "S2", 20, "Soil", (0.8, 1.6)),
    # Radar (computed in build_data.py)
    "VV":    I(None, "S1", 10, "Radar", (-25, -5), "VV (dB)"),
    "VH":    I(None, "S1", 10, "Radar", (-30, -10), "VH (dB)"),
    "VH_VV": I(None, "S1", 10, "Radar", (-20, -5), "VH-VV (dB)"),
    "RVI":   I(None, "S1", 10, "Radar", (0, 1), "RVI"),
    "SoilWetness_rel": I(None, "DERIVED", 10, "Soil moisture", (0, 1), "Relative soil wetness (0-1)"),
    # Thermal
    "LST": I(None, "LANDSAT", 30, "Thermal", (15, 50), "Land surface temp (C)"),
}


GAPFILL_DAYS = 45           # search +/- 45 days around a cloudy month
MIN_GAPFILL_CLEAR = 0.10    # accept gap-filled images with at least 10% clear area