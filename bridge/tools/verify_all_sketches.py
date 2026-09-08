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

swDocPART = 1
SW_HIDE_ALL = 198
SW_HIDE_SHOW_SKETCH_DIMS = 616
SW_DISPLAY_ANNOT = 31
SW_DISPLAY_FEAT_DIM = 32
SW_DISPLAY_ALL_ANNOT = 197


def call(obj, name, *args):
    attr = getattr(obj, name)
    try:
        return attr(*args)
    except TypeError:
        return attr
    except Exception:
        try:
            return attr
        except Exception:
            return None


def prefs(sw, model):
    for code, on in (
        (10, False),
        (SW_HIDE_ALL, False),
        (SW_HIDE_SHOW_SKETCH_DIMS, True),
        (SW_DISPLAY_ANNOT, True),
        (SW_DISPLAY_FEAT_DIM, True),
        (SW_DISPLAY_ALL_ANNOT, True),
        (463, True),
        (465, True),
    ):
        try:
            sw.SetUserPreferenceToggle(code, on)
        except Exception:
            pass
        try:
            model.SetUserPreferenceToggle(code, on)
        except Exception:
            pass


def count_dims(feat):
    n = 0
    try:
        dd = call(feat, "GetFirstDisplayDimension")
        while dd is not None:
            n += 1
            try:
                dd.ShowDimensionValue = True
                ann = call(dd, "GetAnnotation")
                if ann is not None:
                    ann.Visible = 1
            except Exception:
                pass
            dd = call(feat, "GetNextDisplayDimension", dd)
    except Exception:
        pass
    return n


def save_jpg(model, dest, w=1600, h=1200):
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    bmp = os.path.splitext(dest)[0] + "-edit.bmp"
    try:
        if os.path.isfile(bmp):
            os.remove(bmp)
    except OSError:
        pass
    ok = call(model, "SaveBMP", bmp, w, h)
    time.sleep(0.4)
    if not ok or not os.path.isfile(bmp):
        return dest, False, 0
    try:
        from PIL import Image

        img = Image.open(bmp)
        img.convert("RGB").save(dest, "JPEG", quality=90)
        img.close()
        try:
            os.remove(bmp)
        except OSError:
            pass
    except Exception:
        dest = bmp
    return dest, os.path.isfile(dest), os.path.getsize(dest) if os.path.isfile(dest) else 0


def dump_feat(model, feat, name: str, still: str) -> dict:
    nd = count_dims(feat)
    call(model, "ClearSelection2", True)
    sel = call(feat, "Select2", False, 0)
    try:
        call(model, "EditSketch")
    except Exception as e:
        return {"name": name, "editError": str(e), "displayDims": nd, "selected": bool(sel)}
    time.sleep(0.4)
    call(model, "ViewZoomtofit2")
    try:
        call(model, "ShowNamedView2", "*Normale a", -1)
    except Exception:
        pass
    try:
        call(model, "GraphicsRedraw2")
    except Exception:
        pass
    time.sleep(0.4)
    nd2 = count_dims(feat)
    status = -1
    try:
        status = int(call(model, "GetSketchStatus") or -1)
    except Exception:
        pass
    bmp = os.path.join(EXPORT, still)
    path, bmp_ok, bmp_sz = save_jpg(model, bmp)
    try:
        call(model.SketchManager, "InsertSketch", False)
    except Exception:
        try:
            call(model, "InsertSketch2", False)
        except Exception:
            pass
    return {
        "name": name,
        "displayDimsBefore": nd,
        "displayDims": nd2,
        "status": status,
        "bmp": path,
        "bmpOk": bmp_ok,
        "bmpBytes": bmp_sz,
    }


def main() -> int:
    pythoncom.CoInitialize()
    sw = win32com.client.GetObject(Class="SldWorks.Application")
    try:
        sw.Visible = True
    except Exception:
        pass
    target = sys.argv[1] if len(sys.argv) > 1 else "PiastraDueSchizzi.SLDPRT"
    path = os.path.join(CAD, target)
    model = call(sw, "OpenDoc", path, swDocPART)
    if model is None:
        model = sw.ActiveDoc
    if model is None:
        print(json.dumps({"error": "open failed", "path": path}))
        return 1
    title = call(model, "GetTitle")
    dtype = call(model, "GetType")
    try:
        call(sw, "ActivateDoc", title)
    except Exception:
        pass
    prefs(sw, model)
    feats = []
    feat = call(model, "FirstFeature")
    while feat is not None:
        t = call(feat, "GetTypeName2") or ""
        if str(t) == "ProfileFeature":
            nm = str(call(feat, "Name") or "")
            still = target.replace(".SLDPRT", "") + f"-edit-{nm}.jpg"
            feats.append(dump_feat(model, feat, nm, still))
        feat = call(feat, "GetNextFeature")
    print(json.dumps({"part": target, "title": title, "docType": dtype, "features": feats}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
