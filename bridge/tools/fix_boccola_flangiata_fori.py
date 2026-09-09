"""Ricrea i 4 fori Ø6.5 sulla flangia senza FullyDefineSketch (che li ingrandiva)."""
from __future__ import annotations

import pythoncom
import win32com.client

CAD = r"C:\Users\Carli\.ARCHIVIO\CADTM_BUSINESS\00_PROGETTI_3D\01_Progetti_Attivi\SolidworksIA\CAD\BoccolaFlangiata.SLDPRT"
Nothing = pythoncom.Missing

swEndCondThroughAll = 1
swStartSketchPlane = 0


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


def select(model, name, typ):
    ext = model.Extension
    for dummy in (Nothing, None):
        try:
            ok = ext.SelectByID2(name, typ, 0, 0, 0, False, 0, dummy, 0)
            if ok:
                return True
        except Exception:
            continue
    feat = call(model, "FirstFeature")
    while feat is not None:
        if str(call(feat, "Name") or "") == name:
            try:
                return bool(feat.Select2(False, 0))
            except Exception:
                return False
        feat = call(feat, "GetNextFeature")
    return False


def main():
    pythoncom.CoInitialize()
    sw = win32com.client.GetObject(Class="SldWorks.Application")
    sw.Visible = True
    model = call(sw, "OpenDoc", CAD, 1) or sw.ActiveDoc
    print("doc", call(model, "GetTitle"))
    call(sw, "ActivateDoc", call(model, "GetTitle") or "BoccolaFlangiata")

    if select(model, "Taglio-Estrusione1", "BODYFEATURE"):
        call(model, "EditDelete")
        print("deleted cut")
    else:
        print("no cut to delete")

    if not select(model, "Piano superiore", "PLANE"):
        if not select(model, "Top Plane", "PLANE"):
            print("no top plane")
            return
    sm = model.SketchManager
    try:
        sm.AutoInference = False
    except Exception:
        pass
    try:
        sm.AutoSolve = False
    except Exception:
        pass
    sm.InsertSketch(True)
    r = 0.0065 / 2
    pcd = 0.020
    pts = [(pcd, 0), (-pcd, 0), (0, pcd), (0, -pcd)]
    for x, y in pts:
        sm.CreateCircleByRadius(x, y, 0, r)
        print("circle", x, y, "r", r)
    try:
        sm.AutoSolve = True
    except Exception:
        pass
    sm.InsertSketch(False)

    # Select the newest sketch
    last = None
    feat = call(model, "FirstFeature")
    while feat is not None:
        tn = str(call(feat, "GetTypeName2") or "")
        if tn == "ProfileFeature":
            last = feat
        feat = call(feat, "GetNextFeature")
    if last is not None:
        try:
            last.Select2(False, 0)
            print("selected", call(last, "Name"))
        except Exception as ex:
            print("select sketch", ex)

    featMgr = model.FeatureManager
    t1 = swEndCondThroughAll
    cut = None
    for flip_dir in (True, False):
        try:
            cut = featMgr.FeatureCut3(
                True, False, flip_dir, t1, 0, 0.01, 0,
                False, False, False, False, 0.0, 0.0,
                False, False, False, False,
                False, True, True, True, True, False,
                swStartSketchPlane, 0, False,
            )
        except Exception as ex:
            print("FeatureCut3", flip_dir, ex)
            cut = None
        if cut is not None:
            print("cut ok flip", flip_dir, cut)
            break
    if cut is None:
        print("CUT FAIL")
        return
    call(model, "ForceRebuild3", True)
    ext = model.Extension
    mass = call(ext, "CreateMassProperty2") or call(ext, "CreateMassProperty")
    if mass:
        print("mass_kg", float(mass.Mass), "volume_m3", float(mass.Volume))
    box = call(model, "GetPartBox", True)
    print("bbox", box)
    errs = 0
    warns = 0
    try:
        model.Save3(1, errs, warns)
    except Exception:
        call(model, "Save")
    print("saved", CAD)


if __name__ == "__main__":
    main()
