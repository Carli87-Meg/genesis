"""Open a saved part, EditSketch, capture quoted sketch (shop-floor check)."""
import os
import time

import pythoncom
import win32com.client

CAD = r"C:\Users\Carli\.ARCHIVIO\CADTM_BUSINESS\00_PROGETTI_3D\01_Progetti_Attivi\SolidworksIA\CAD"
EXPORT = r"C:\Users\Carli\.ARCHIVIO\CADTM_BUSINESS\00_PROGETTI_3D\01_Progetti_Attivi\SolidworksIA\Export"
MEDIA = r"C:\Users\Carli\AppData\Local\Cursor\AgentStores\cursor_agent_stores\bc-70dc7761-0ccf-4f66-a8ad-40094baa66b8\files\media"

SW_HIDE_ALL = 198
SW_HIDE_SHOW_SKETCH_DIMS = 616
SW_DISPLAY_ANNOT = 31
SW_DISPLAY_FEAT_DIM = 32
SW_DISPLAY_ALL_ANNOT = 197
SW_ADD_DIM_RECT = 463
SW_ADD_DIM_CIRCLE = 465
SW_INPUT_DIM = 10
RELATIONS_ALL = 1023


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
        (SW_INPUT_DIM, False),
        (SW_HIDE_ALL, False),
        (SW_HIDE_SHOW_SKETCH_DIMS, True),
        (SW_DISPLAY_ANNOT, True),
        (SW_DISPLAY_FEAT_DIM, True),
        (SW_DISPLAY_ALL_ANNOT, True),
        (SW_ADD_DIM_RECT, True),
        (SW_ADD_DIM_CIRCLE, True),
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
    ok = call(model, "SaveBMP", bmp, w, h)
    if not ok or not os.path.isfile(bmp):
        print("  SaveBMP fail", dest)
        return None
    try:
        from PIL import Image

        im = Image.open(bmp)
        im.convert("RGB").save(dest, "JPEG", quality=90)
        try:
            os.remove(bmp)
        except OSError:
            pass
    except Exception as ex:
        print("  jpeg", ex)
        dest = bmp
    print("  saved", dest, os.path.getsize(dest))
    return dest


def fully_define(sk):
    try:
        n = sk.FullyDefineSketch(
            True, True, RELATIONS_ALL, True,
            1, None, 1, None, -1, 1,
        )
        print("  FullyDefineSketch", n)
        return n
    except Exception as ex:
        print("  FullyDefineSketch fail", ex)
        return 0


def quote_open_sketches(sw, path, stem):
    print("===", path)
    model = call(sw, "OpenDoc", path, 1)
    if model is None:
        model = sw.ActiveDoc
    print("  title", call(model, "GetTitle"))
    prefs(sw, model)
    try:
        call(model, "ShowFeatureDimensions")
    except Exception:
        pass

    feat = call(model, "FirstFeature")
    idx = 0
    last_still = None
    while feat is not None:
        tn = call(feat, "GetTypeName2")
        name = call(feat, "Name")
        if tn == "ProfileFeature":
            idx += 1
            nd = count_dims(feat)
            print(f"  sketch {name} displayDims={nd}")
            call(model, "ClearSelection2", True)
            call(feat, "Select2", False, 0)
            try:
                call(model, "EditSketch")
            except Exception as ex:
                print("  EditSketch", ex)
            prefs(sw, model)
            sk = model.SketchManager
            try:
                sk.DisplayWhenAdded = True
                sk.AddToDB = False
            except Exception:
                pass
            if nd == 0:
                fully_define(sk)
                nd = count_dims(feat)
                print(f"  after FullyDefine displayDims={nd}")
            try:
                call(model, "ViewZoomtofit2")
                call(model, "GraphicsRedraw2")
            except Exception:
                pass
            time.sleep(0.5)
            dest = os.path.join(EXPORT, f"{stem}-edit-schizzo{idx}.jpg")
            last_still = save_jpg(model, dest)
            try:
                call(sk, "InsertSketch", False)
            except Exception:
                try:
                    call(model, "InsertSketch2", False)
                except Exception:
                    pass
            try:
                call(model, "Save3", 1, 0, 0)
            except Exception:
                try:
                    call(model, "Save")
                except Exception:
                    pass
        feat = call(feat, "GetNextFeature")

    return last_still, call(model, "GetTitle")


def main():
    pythoncom.CoInitialize()
    sw = win32com.client.Dispatch(win32com.client.GetObject(Class="SldWorks.Application"))
    sw.Visible = True
    still, title = quote_open_sketches(
        sw,
        os.path.join(CAD, "PiastraQuotata.SLDPRT"),
        "PiastraQuotata",
    )
    if still and os.path.isfile(still):
        dest = os.path.join(MEDIA, "schizzi-quotati-01.jpg")
        import shutil

        shutil.copyfile(still, dest)
        print("copied", dest, os.path.getsize(dest))
    # close this part so we can check fiancata too
    try:
        sw.CloseDoc(title)
    except Exception:
        pass
    still2, title2 = quote_open_sketches(
        sw,
        os.path.join(CAD, "FiancataSx.SLDPRT"),
        "FiancataSx",
    )
    if still2 and os.path.isfile(still2):
        dest = os.path.join(MEDIA, "schizzi-quotati-02.jpg")
        import shutil

        shutil.copyfile(still2, dest)
        print("copied", dest)
    try:
        sw.CloseDoc(title2)
    except Exception:
        pass


if __name__ == "__main__":
    main()
