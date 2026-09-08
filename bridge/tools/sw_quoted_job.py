"""One-off SolidWorks COM job: quoted sketches + scala module. Do not CreateObject."""
from __future__ import annotations

import os
import time
import traceback

import pythoncom
import win32com.client

OUT = r"C:\Users\Carli\.ARCHIVIO\CADTM_BUSINESS\00_PROGETTI_3D\01_Progetti_Attivi\SolidworksIA"
CAD = os.path.join(OUT, "CAD")
EXPORT = os.path.join(OUT, "Export")
PART_TPL = r"C:\ProgramData\SolidWorks\SOLIDWORKS 2025\templates\Parte.PRTDOT"
ASM_TPL = r"C:\ProgramData\SolidWorks\SOLIDWORKS 2025\templates\Assieme.ASMDOT"

# swUserPreferenceToggle_e
SW_INPUT_DIM_VAL = 10
SW_HIDE_ALL_TYPES = 198
SW_DISPLAY_ANNOT = 31
SW_DISPLAY_FEAT_DIM = 32
SW_DISPLAY_ALL_ANNOT = 197
SW_HIDE_SHOW_SKETCH_DIMS = 616
SW_ADD_DIM_SKETCH = 440
SW_ADD_DIM_RECT = 463
SW_ADD_DIM_CIRCLE = 465
SW_ADD_DIM_LINE = 462
SW_CREATE_DIM_ONLY_WHEN_ENTERED = 520
SW_DISPLAY_SKETCHES = 196
SW_FLAT_TO_SCREEN = 332

SW_DOC_PART = 1
SW_DOC_ASM = 2
SW_SAVE_SILENT = 1
SW_OPEN_SILENT = 1

RELATIONS_ALL = 1023
SCHEME_BASELINE = 1
PLACE_H_BELOW = -1
PLACE_V_RIGHT = 1


def attach():
    pythoncom.CoInitialize()
    raw = win32com.client.GetObject(Class="SldWorks.Application")
    try:
        sw = win32com.client.gencache.EnsureDispatch(raw)
    except Exception:
        sw = raw
    sw.Visible = True
    try:
        sw.UserControl = True
    except Exception:
        pass
    return sw


def pref(sw, model, code, on):
    try:
        sw.SetUserPreferenceToggle(code, on)
    except Exception:
        pass
    if model is not None:
        try:
            model.SetUserPreferenceToggle(code, on)
        except Exception:
            pass
        try:
            model.Extension.SetUserPreferenceToggle(code, 0, on)
        except Exception:
            pass


def enable_dims(sw, model):
    pref(sw, model, SW_INPUT_DIM_VAL, False)
    pref(sw, model, SW_CREATE_DIM_ONLY_WHEN_ENTERED, False)
    pref(sw, model, SW_HIDE_ALL_TYPES, False)
    pref(sw, model, SW_HIDE_SHOW_SKETCH_DIMS, True)
    pref(sw, model, SW_DISPLAY_ANNOT, True)
    pref(sw, model, SW_DISPLAY_FEAT_DIM, True)
    pref(sw, model, SW_DISPLAY_ALL_ANNOT, True)
    pref(sw, model, SW_DISPLAY_SKETCHES, True)
    pref(sw, model, SW_FLAT_TO_SCREEN, True)
    pref(sw, model, SW_ADD_DIM_SKETCH, True)
    pref(sw, model, SW_ADD_DIM_RECT, True)
    pref(sw, model, SW_ADD_DIM_CIRCLE, True)
    pref(sw, model, SW_ADD_DIM_LINE, True)


def select_plane(model, names):
    feat = model.FirstFeature()
    wanted = [n.lower() for n in names]
    while feat is not None:
        try:
            tn = feat.GetTypeName2()
        except Exception:
            tn = ""
        if tn == "RefPlane":
            nm = (feat.Name or "").lower()
            if any(w in nm or nm == w for w in wanted):
                feat.Select2(False, 0)
                return True
        feat = feat.GetNextFeature()
    return False


def count_sketch_dims(model):
    n = 0
    last = None
    feat = model.FirstFeature()
    while feat is not None:
        try:
            tn = feat.GetTypeName2()
        except Exception:
            tn = ""
        if tn == "ProfileFeature":
            last = feat
        feat = feat.GetNextFeature()
    if last is None:
        return 0
    try:
        dd = last.GetFirstDisplayDimension()
        while dd is not None:
            n += 1
            try:
                dd.ShowDimensionValue = True
            except Exception:
                pass
            try:
                ann = dd.GetAnnotation()
                if ann is not None:
                    ann.Visible = 1
            except Exception:
                pass
            dd = last.GetNextDisplayDimension(dd)
    except Exception:
        pass
    return n


def fully_define(sk):
    try:
        n = sk.FullyDefineSketch(
            True,
            True,
            RELATIONS_ALL,
            True,
            SCHEME_BASELINE,
            None,
            SCHEME_BASELINE,
            None,
            PLACE_H_BELOW,
            PLACE_V_RIGHT,
        )
        print(f"  FullyDefineSketch result={n}")
        return n
    except Exception as ex:
        print(f"  FullyDefineSketch fail: {ex}")
        return 0


def save_bmp(model, dest, w=1600, h=1200):
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    bmp = os.path.splitext(dest)[0] + ".bmp"
    ok = False
    try:
        ok = bool(model.SaveBMP(bmp, w, h))
    except Exception as ex:
        print(f"  SaveBMP fail: {ex}")
    if ok and os.path.isfile(bmp):
        # keep bmp and also jpeg via PIL if present; else just rename path
        try:
            from PIL import Image

            im = Image.open(bmp)
            im.convert("RGB").save(dest, "JPEG", quality=90)
            try:
                os.remove(bmp)
            except OSError:
                pass
        except Exception:
            dest = bmp
        print(f"  saved {dest}")
        return dest
    print("  SaveBMP missing file")
    return None


def save_as(model, path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if os.path.isfile(path):
        try:
            os.remove(path)
        except OSError:
            pass
    err = win32com.client.VARIANT(pythoncom.VT_I4 | pythoncom.VT_BYREF, 0)
    warn = win32com.client.VARIANT(pythoncom.VT_I4 | pythoncom.VT_BYREF, 0)
    try:
        model.SaveAs3(path, 0, SW_SAVE_SILENT)
        print(f"  SaveAs3 {path}")
        return True
    except Exception:
        pass
    try:
        ok = model.Extension.SaveAs(path, 0, SW_SAVE_SILENT, None, err, warn)
        print(f"  SaveAs {path} ok={ok} err={err.value} warn={warn.value}")
        return bool(ok)
    except Exception as ex:
        print(f"  SaveAs fail: {ex}")
        return False


def close_title(sw, title):
    if not title:
        return
    try:
        sw.CloseDoc(title)
        print(f"  CloseDoc {title}")
    except Exception as ex:
        print(f"  CloseDoc fail {title}: {ex}")


def list_docs(sw):
    titles = []
    try:
        docs = sw.GetDocuments()
        if docs is None:
            return titles
        if isinstance(docs, tuple):
            seq = docs
        else:
            try:
                seq = list(docs)
            except TypeError:
                seq = [docs]
        for d in seq:
            if d is None:
                continue
            try:
                titles.append((d.GetTitle(), d.GetType()))
            except Exception:
                pass
    except Exception as ex:
        print(f"  list_docs: {ex}")
    return titles


def new_part(sw):
    model = sw.NewDocument(PART_TPL, 0, 0, 0)
    if model is None:
        model = sw.ActiveDoc
    return model


def new_assembly(sw):
    model = sw.NewDocument(ASM_TPL, 0, 0, 0)
    if model is None:
        model = sw.ActiveDoc
    return model


def quote_and_snapshot(sw, model, sk, still_path):
    enable_dims(sw, model)
    try:
        sk.AddToDB = False
    except Exception:
        pass
    try:
        sk.DisplayWhenAdded = True
    except Exception:
        pass
    n = count_sketch_dims(model)
    if n == 0:
        fully_define(sk)
        n = count_sketch_dims(model)
    print(f"  sketch display dims={n}")
    try:
        model.ViewDisplayHiddenremoved()
    except Exception:
        pass
    try:
        model.ViewZoomtofit2()
    except Exception:
        pass
    try:
        model.GraphicsRedraw2()
    except Exception:
        pass
    time.sleep(0.5)
    saved = save_bmp(model, still_path)
    try:
        model.ViewDisplayShaded()
    except Exception:
        pass
    return n, saved


def make_plate(sw):
    print("=== PiastraQuotata ===")
    model = new_part(sw)
    enable_dims(sw, model)
    if not select_plane(model, ["piano superiore", "top plane", "top"]):
        print("  plane Top missing, trying first RefPlane")
        feat = model.FirstFeature()
        while feat is not None:
            if feat.GetTypeName2() == "RefPlane":
                feat.Select2(False, 0)
                break
            feat = feat.GetNextFeature()
    sk = model.SketchManager
    sk.InsertSketch(True)
    sk.AddToDB = False
    try:
        sk.DisplayWhenAdded = True
    except Exception:
        pass
    # meters
    sk.CreateCornerRectangle(-0.040, -0.025, 0, 0.040, 0.025, 0)
    for cx, cy in ((0.032, 0.017), (-0.032, 0.017), (0.032, -0.017), (-0.032, -0.017)):
        sk.CreateCircleByRadius(cx, cy, 0, 0.00325)
    n, still = quote_and_snapshot(
        sw, model, sk, os.path.join(EXPORT, "PiastraQuotata-schizzo.jpg")
    )
    sk.InsertSketch(False)
    feat_mgr = model.FeatureManager
    try:
        feat_mgr.FeatureExtrusion3(
            True, False, False, 0, 0, 0.008, 0.0,
            False, False, False, False, 0.0, 0.0,
            False, False, False, False,
            True, True, True,
            0, 0.0, False,
        )
    except Exception as ex:
        print(f"  extrude: {ex}")
    try:
        model.ForceRebuild3(True)
    except Exception:
        pass
    try:
        model.ShowFeatureDimensions()
    except Exception:
        pass
    try:
        model.ShowNamedView2("*Isometric", -1)
    except Exception:
        pass
    try:
        model.ViewZoomtofit2()
    except Exception:
        pass
    save_bmp(model, os.path.join(EXPORT, "PiastraQuotata.jpg"), 1400, 1000)
    save_as(model, os.path.join(CAD, "PiastraQuotata.SLDPRT"))
    title = model.GetTitle()
    close_title(sw, title)
    return n, still


def make_prism(sw, name, plane_names, width, height, depth, holes):
    print(f"=== {name} ===")
    model = new_part(sw)
    enable_dims(sw, model)
    if not select_plane(model, plane_names):
        print("  plane not found")
    sk = model.SketchManager
    sk.InsertSketch(True)
    try:
        sk.AddToDB = False
        sk.DisplayWhenAdded = True
    except Exception:
        pass
    w, h = width / 1000.0, height / 1000.0
    sk.CreateCornerRectangle(-w / 2, -h / 2, 0, w / 2, h / 2, 0)
    for cx, cy, d in holes:
        sk.CreateCircleByRadius(cx / 1000.0, cy / 1000.0, 0, (d / 1000.0) / 2)
    quote_and_snapshot(sw, model, sk, os.path.join(EXPORT, f"{name}-schizzo.jpg"))
    sk.InsertSketch(False)
    try:
        model.FeatureManager.FeatureExtrusion3(
            True, False, False, 0, 0, depth / 1000.0, 0.0,
            False, False, False, False, 0.0, 0.0,
            False, False, False, False,
            True, True, True,
            0, 0.0, False,
        )
    except Exception as ex:
        print(f"  extrude: {ex}")
    try:
        model.ForceRebuild3(True)
        model.ViewZoomtofit2()
    except Exception:
        pass
    save_bmp(model, os.path.join(EXPORT, f"{name}.jpg"), 1200, 900)
    path = os.path.join(CAD, f"{name}.SLDPRT")
    save_as(model, path)
    close_title(sw, model.GetTitle())
    return path


def add_component(sw, assy_model, assy, path, x, y, z, fix=False):
    err = warn = 0
    try:
        sw.OpenDoc6(path, SW_DOC_PART, SW_OPEN_SILENT, "", err, warn)
    except Exception as ex:
        print(f"  OpenDoc6 {path}: {ex}")
    try:
        aerr = 0
        sw.ActivateDoc3(assy_model.GetTitle(), False, 0, aerr)
    except Exception:
        try:
            sw.ActivateDoc(assy_model.GetTitle())
        except Exception:
            pass
    comp = None
    try:
        comp = assy.AddComponent5(path, 0, "", False, "", x, y, z)
    except Exception as ex:
        print(f"  AddComponent5: {ex}")
        try:
            comp = assy.AddComponent(path, x, y, z)
        except Exception as ex2:
            print(f"  AddComponent: {ex2}")
    if comp is None:
        print(f"  component FAIL {path}")
        return None
    name = comp.Name2
    print(f"  component {name}")
    if fix:
        try:
            comp.Select4(False, None, False)
            assy.FixComponent()
            print("  FixComponent")
        except Exception as ex:
            print(f"  FixComponent: {ex}")
    try:
        sw.CloseDoc(os.path.basename(path))
        aerr = 0
        sw.ActivateDoc3(assy_model.GetTitle(), False, 0, aerr)
    except Exception:
        pass
    return name


def select_cylinder(assy_model, assy, comp_name, inner=True, diameter_mm=8):
    comps = assy.GetComponents(False)
    if comps is None:
        return False
    if not isinstance(comps, tuple):
        try:
            comps = tuple(comps)
        except TypeError:
            comps = (comps,)
    target = None
    for c in comps:
        if c is None:
            continue
        n = c.Name2 or ""
        if n == comp_name or n.startswith(comp_name.split("-")[0]):
            target = c
            break
    if target is None:
        print(f"  FindComponent miss {comp_name}")
        return False
    part = target.GetModelDoc2()
    if part is None:
        return False
    want_r = (diameter_mm / 1000.0) / 2.0
    best = None
    best_score = 1e9
    bodies = part.GetBodies2(0, True)
    if bodies is None:
        return False
    if not isinstance(bodies, tuple):
        bodies = (bodies,)
    for body in bodies:
        if body is None:
            continue
        faces = body.GetFaces()
        if faces is None:
            continue
        if not isinstance(faces, tuple):
            faces = (faces,)
        for face in faces:
            try:
                surf = face.GetSurface()
                if not surf.IsCylinder():
                    continue
                p = surf.CylinderParams
                r = abs(p[6])
                score = abs(r - want_r)
                if inner and r > want_r * 1.4:
                    continue
                if score < best_score:
                    best_score = score
                    best = face
            except Exception:
                continue
    if best is None:
        print(f"  no cylinder {comp_name}")
        return False
    corr = target.GetCorresponding(best)
    ok = corr.Select4(True, None)
    print(f"  cyl {comp_name} r_err={best_score*1000:.3f}mm sel={ok}")
    return bool(ok)


def add_concentric(assy_model, assy, a, b, d=8):
    assy_model.ClearSelection2(True)
    s1 = select_cylinder(assy_model, assy, a, True, d)
    s2 = select_cylinder(assy_model, assy, b, True, d)
    if not (s1 and s2):
        print(f"  mate sel fail {a}/{b} {s1}/{s2}")
        return False
    errors = 0
    mate = None
    for align in (0, 1, 2):
        for flip in (False, True):
            assy_model.ClearSelection2(True)
            select_cylinder(assy_model, assy, a, True, d)
            select_cylinder(assy_model, assy, b, True, d)
            try:
                mate = assy.AddMate5(1, align, flip, 0, 0, 0, 0, 0, 0, 0, 0, False, False, 0, errors)
            except Exception as ex:
                print(f"  AddMate5: {ex}")
                mate = None
            if mate is not None:
                print(f"  concentric {a}-{b} align={align} flip={flip}")
                return True
    print(f"  concentric FAIL {a}-{b}")
    return False


def make_scala(sw):
    sx = make_prism(
        sw, "FiancataSx", ["piano frontale", "front plane", "front"],
        600, 40, 8, [(-220, 0, 8), (220, 0, 8)],
    )
    dx = make_prism(
        sw, "FiancataDx", ["piano frontale", "front plane", "front"],
        600, 40, 8, [(-220, 0, 8), (220, 0, 8)],
    )
    s1 = make_prism(
        sw, "Scalino1", ["piano superiore", "top plane", "top"],
        700, 220, 6, [(-346, 0, 8), (346, 0, 8)],
    )
    s2 = make_prism(
        sw, "Scalino2", ["piano superiore", "top plane", "top"],
        700, 220, 6, [(-346, 0, 8), (346, 0, 8)],
    )
    piede = make_prism(
        sw, "Piede", ["piano superiore", "top plane", "top"],
        80, 80, 8, [],
    )
    print("=== AssiemeScala ===")
    model = new_assembly(sw)
    assy = model
    # IAssemblyDoc is the same COM object
    n_sx = add_component(sw, model, assy, sx, 0, 0, 0, fix=True)
    n_dx = add_component(sw, model, assy, dx, 0, 0, 0.708, fix=False)
    n_s1 = add_component(sw, model, assy, s1, -0.220, 0.020, 0.354, fix=False)
    n_s2 = add_component(sw, model, assy, s2, 0.220, 0.020, 0.354, fix=False)
    add_component(sw, model, assy, piede, -0.300, -0.020, 0, fix=False)
    mates = 0
    if n_s1 and n_sx:
        mates += int(add_concentric(model, assy, n_s1, n_sx))
    if n_s1 and n_dx:
        mates += int(add_concentric(model, assy, n_s1, n_dx))
    if n_s2 and n_sx:
        mates += int(add_concentric(model, assy, n_s2, n_sx))
    if n_s2 and n_dx:
        mates += int(add_concentric(model, assy, n_s2, n_dx))
    print(f"  mates ok={mates}")
    try:
        model.ForceRebuild3(True)
        model.ShowNamedView2("*Isometric", -1)
        model.ViewZoomtofit2()
    except Exception:
        pass
    save_bmp(model, os.path.join(EXPORT, "AssiemeScala.jpg"), 1400, 1000)
    save_as(model, os.path.join(CAD, "AssiemeScala.SLDASM"))
    return model.GetTitle(), mates


def cleanup(sw, keep_title):
    print("=== CloseDoc extra ===")
    keep = (keep_title or "").lower()
    for title, ty in list_docs(sw):
        t = title.lower()
        if keep and (t == keep or t.startswith(keep) or keep in t):
            print(f"  keep {title}")
            continue
        # leave at most last assembly
        if ty == SW_DOC_ASM and keep and keep in t:
            print(f"  keep asm {title}")
            continue
        close_title(sw, title)
    print("open:", list_docs(sw))


def main():
    os.makedirs(CAD, exist_ok=True)
    os.makedirs(EXPORT, exist_ok=True)
    sw = attach()
    print("attached", getattr(sw, "RevisionNumber", lambda: "?")() if callable(getattr(sw, "RevisionNumber", None)) else sw.RevisionNumber)
    # close leftover parts/drawings first, keep nothing
    cleanup(sw, keep_title="")
    n, still = make_plate(sw)
    keep, mates = make_scala(sw)
    cleanup(sw, keep)
    print("RESULT", {"sketchDims": n, "still": still, "assembly": keep, "mates": mates})


if __name__ == "__main__":
    try:
        main()
    except Exception:
        traceback.print_exc()
        raise
