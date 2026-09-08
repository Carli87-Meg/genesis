"""Apre ogni ProfileFeature in EditSketch e conta DisplayDimension visibili."""
from __future__ import annotations

import json
import os
import sys
import time

import pythoncom
import win32com.client

OUT = os.environ.get(
    "SOLIDWORKS_OUT_DIR",
    r"C:\Users\Carli\.ARCHIVIO\CADTM_BUSINESS\00_PROGETTI_3D\01_Progetti_Attivi\SolidworksIA",
)
CAD = os.path.join(OUT, "CAD")
EXPORT = os.path.join(OUT, "Export")
os.makedirs(EXPORT, exist_ok=True)

swOpenDocOptions_Silent = 1
swDocPART = 1
swDocASSEMBLY = 2
swDocDRAWING = 3
swSelSKETCHES = 9
swSelDIMENSIONS = 14
swSketchFullyDefined = 3
swViewNormalTo = 8
swViewZoomtofit = 12


def dump_feat(model, feat, name: str, still: str) -> dict:
    sel = model.Extension.SelectByID2(name, "SKETCH", 0, 0, 0, False, 0, None, 0)
    if not sel:
        return {"name": name, "selected": False}
    try:
        model.EditSketch()
    except Exception as e:
        return {"name": name, "editError": str(e)}
    time.sleep(0.4)
    model.ViewZoomtofit2()
    try:
        model.ShowNamedView2("*Normale a", -1)
    except Exception:
        pass
    time.sleep(0.3)
    sk = model.SketchManager.ActiveSketch
    n = 0
    if sk is not None:
        try:
            n = int(sk.GetDisplayDimensionCount2(0) or 0)
        except Exception:
            try:
                n = int(sk.GetDisplayDimensionCount() or 0)
            except Exception:
                n = -1
    status = -1
    try:
        status = int(model.GetSketchStatus())
    except Exception:
        pass
    bmp = os.path.join(EXPORT, still)
    try:
        if os.path.isfile(bmp):
            os.remove(bmp)
        model.SaveBMP(bmp, 1400, 900)
        time.sleep(0.4)
        bmp_ok = os.path.isfile(bmp)
        bmp_sz = os.path.getsize(bmp) if bmp_ok else 0
    except Exception as e:
        bmp_ok, bmp_sz = False, 0
        bmp = str(e)
    try:
        model.InsertSketch2(True)
    except Exception:
        pass
    return {
        "name": name,
        "displayDims": n,
        "status": status,
        "fullyDefined": status == swSketchFullyDefined,
        "bmp": bmp if isinstance(bmp, str) else still,
        "bmpOk": bmp_ok if isinstance(bmp_ok, bool) else False,
        "bmpBytes": bmp_sz,
    }


def main() -> int:
    pythoncom.CoInitialize()
    sw = win32com.client.GetObject(Class="SldWorks.Application")
    target = sys.argv[1] if len(sys.argv) > 1 else "PiastraDueSchizzi.SLDPRT"
    path = os.path.join(CAD, target)
    model = sw.OpenDoc(path, swDocPART)
    if model is None:
        model = sw.ActiveDoc
    if model is None:
        print(json.dumps({"error": "open failed", "path": path}))
        return 1
    try:
        sw.ActivateDoc(model.GetTitle)
    except Exception:
        pass
    try:
        model.ViewZoomtofit2()
    except Exception:
        pass
    feats = []
    feat = model.FirstFeature
    while feat is not None:
        t = ""
        try:
            t = str(feat.GetTypeName2() or "")
        except Exception:
            pass
        if t == "ProfileFeature":
            nm = str(feat.Name)
            still = target.replace(".SLDPRT", "") + f"-edit-{nm}.jpg"
            feats.append(dump_feat(model, feat, nm, still))
        try:
            feat = feat.GetNextFeature()
        except Exception:
            break
    print(json.dumps({"part": target, "features": feats}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
