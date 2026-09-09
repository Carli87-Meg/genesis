"""Verifica GUI boccola flangiata e cattura still nuovi."""
from __future__ import annotations

import ctypes
import os
import shutil
import time

import pythoncom
import win32com.client
import win32con
import win32gui
import win32ui
from PIL import Image

EXPORT = r"C:\Users\Carli\.ARCHIVIO\CADTM_BUSINESS\00_PROGETTI_3D\01_Progetti_Attivi\SolidworksIA\Export"
CAD = r"C:\Users\Carli\.ARCHIVIO\CADTM_BUSINESS\00_PROGETTI_3D\01_Progetti_Attivi\SolidworksIA\CAD"
DRAW = r"C:\Users\Carli\.ARCHIVIO\CADTM_BUSINESS\00_PROGETTI_3D\01_Progetti_Attivi\SolidworksIA\Disegni"
MEDIA = r"C:\Users\Carli\AppData\Local\Cursor\AgentStores\cursor_agent_stores\bc-70dc7761-0ccf-4f66-a8ad-40094baa66b8\files\media"
AGENT = r"C:\Users\Carli\AppData\Local\Cursor\AgentStores\cursor_agent_stores\bc-b6ca3bc0-abc8-5688-a74e-4b89deefc85f\files\media"
PW_RENDERFULLCONTENT = 2
swFront, swIso = 1, 7
Nothing = pythoncom.Missing


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


def save_all(name, im):
    dests = []
    for folder in (EXPORT, MEDIA, AGENT):
        os.makedirs(folder, exist_ok=True)
        dest = os.path.join(folder, name)
        if isinstance(im, str):
            if os.path.abspath(im) == os.path.abspath(dest):
                dests.append(dest)
                continue
            shutil.copyfile(im, dest)
        else:
            im.save(dest, "JPEG", quality=92)
        dests.append(dest)
        n = os.path.getsize(dest)
        print("ok" if n > 0 else "FAIL", n, dest)
    return dests


def save_view(model, dest, view_id=None):
    if view_id is not None:
        call(model, "ShowNamedView2", "", view_id)
        time.sleep(0.25)
    call(model, "ViewZoomtofit2")
    call(model, "GraphicsRedraw2")
    time.sleep(0.4)
    bmp = os.path.splitext(dest)[0] + ".bmp"
    if os.path.isfile(bmp):
        try:
            os.remove(bmp)
        except OSError:
            pass
    call(model, "SaveBMP", bmp, 1600, 1200)
    time.sleep(0.4)
    if not os.path.isfile(bmp):
        print("fail view", dest)
        return False
    Image.open(bmp).convert("RGB").save(dest, "JPEG", quality=90)
    try:
        os.remove(bmp)
    except OSError:
        pass
    print("view", dest, os.path.getsize(dest))
    return True


def find_sw_hwnd(prefer: str):
    found = []

    def cb(hwnd, _):
        if not win32gui.IsWindowVisible(hwnd):
            return True
        t = win32gui.GetWindowText(hwnd) or ""
        if "SOLIDWORKS" in t.upper() and t.strip():
            found.append((hwnd, t))
        return True

    win32gui.EnumWindows(cb, None)
    for hwnd, t in found:
        if prefer.lower() in t.lower():
            return hwnd, t
    return (found[0][0], found[0][1]) if found else (None, "")


def print_window(hwnd):
    left, top, right, bot = win32gui.GetWindowRect(hwnd)
    w, h = right - left, bot - top
    hwnd_dc = win32gui.GetWindowDC(hwnd)
    mfc = win32ui.CreateDCFromHandle(hwnd_dc)
    save = mfc.CreateCompatibleDC()
    bmp = win32ui.CreateBitmap()
    bmp.CreateCompatibleBitmap(mfc, w, h)
    save.SelectObject(bmp)
    ctypes.windll.user32.PrintWindow(hwnd, save.GetSafeHdc(), PW_RENDERFULLCONTENT)
    bits = bmp.GetBitmapBits(True)
    img = Image.frombuffer("RGB", (w, h), bits, "raw", "BGRX", 0, 1).convert("RGB")
    win32gui.ReleaseDC(hwnd, hwnd_dc)
    try:
        save.DeleteDC()
    except Exception:
        pass
    try:
        mfc.DeleteDC()
    except Exception:
        pass
    try:
        win32gui.DeleteObject(bmp.GetHandle())
    except Exception:
        pass
    return img


def select_feat(model, name):
    feat = call(model, "FirstFeature")
    while feat is not None:
        if str(call(feat, "Name") or "") == name:
            try:
                return bool(feat.Select2(False, 0)), feat
            except Exception:
                return False, feat
        feat = call(feat, "GetNextFeature")
    return False, None


def main():
    pythoncom.CoInitialize()
    sw = win32com.client.GetObject(Class="SldWorks.Application")
    sw.Visible = True
    os.makedirs(EXPORT, exist_ok=True)

    part_path = os.path.join(CAD, "BoccolaFlangiata.SLDPRT")
    drw_path = os.path.join(DRAW, "TavolaBoccolaFlangiata.SLDDRW")
    model = call(sw, "OpenDoc", part_path, 1)
    title = call(model, "GetTitle") if model else None
    print("part", title)
    try:
        sw.ActivateDoc(title)
    except Exception:
        pass
    time.sleep(0.4)

    feats = []
    feat = call(model, "FirstFeature")
    while feat is not None:
        feats.append((str(call(feat, "Name") or ""), str(call(feat, "GetTypeName2") or "")))
        feat = call(feat, "GetNextFeature")
    print("features", [(n, t) for n, t in feats if t in ("Revolution", "ICE", "ProfileFeature", "MaterialFolder")])
    has_rev = any(t == "Revolution" for _, t in feats)
    print("HAS_REVOLVE", has_rev)

    ext = model.Extension
    mass = call(ext, "CreateMassProperty2") or call(ext, "CreateMassProperty")
    if mass:
        print("mass_kg", float(mass.Mass), "volume_m3", float(mass.Volume))
    print("bbox_m", call(model, "GetPartBox", True))

    iso = os.path.join(EXPORT, "boccola-flangiata-iso-01.jpg")
    if save_view(model, iso, swIso):
        save_all("boccola-flangiata-iso-01.jpg", iso)

    ok, _ = select_feat(model, "Schizzo1")
    print("select Schizzo1", ok)
    if ok:
        call(model, "EditSketch")
        time.sleep(0.35)
        call(model, "ViewZoomtofit2")
        call(model, "GraphicsRedraw2")
        time.sleep(0.35)
        sk = os.path.join(EXPORT, "boccola-flangiata-schizzo-01.jpg")
        if save_view(model, sk, None):
            save_all("boccola-flangiata-schizzo-01.jpg", sk)
        try:
            model.SketchManager.InsertSketch(False)
        except Exception:
            call(model, "InsertSketch")

    drw = call(sw, "OpenDoc", drw_path, 3)
    dtitle = call(drw, "GetTitle") if drw else None
    print("drawing", dtitle)
    try:
        sw.ActivateDoc(dtitle)
    except Exception:
        pass
    time.sleep(0.6)
    sheet = os.path.join(EXPORT, "boccola-flangiata-tavola-sheet.jpg")
    if save_view(drw, sheet, None):
        save_all("boccola-flangiata-tavola-01.jpg", sheet)
        img = Image.open(sheet)
        w, h = img.size
        zoom = img.crop((int(w * 0.62), int(h * 0.62), w, h))
        save_all("boccola-flangiata-cartiglio-01.jpg", zoom)

    hwnd, wtitle = find_sw_hwnd("TavolaBoccolaFlangiata")
    print("hwnd", wtitle)
    if hwnd:
        win32gui.ShowWindow(hwnd, win32con.SW_MAXIMIZE)
        time.sleep(0.4)
        try:
            win32gui.SetForegroundWindow(hwnd)
        except Exception:
            pass
        time.sleep(0.3)
        gui = print_window(hwnd)
        save_all("boccola-flangiata-tavola-gui-01.jpg", gui)
        cw, ch = gui.size
        save_all("boccola-flangiata-cartiglio-gui-01.jpg", gui.crop((int(cw * 0.55), int(ch * 0.52), cw - 8, ch - 48)))

    # Close extra, keep drawing
    docs = call(sw, "GetDocuments")
    titles = []
    try:
        n = int(docs.Count)
        for i in range(1, n + 1):
            titles.append(str(call(docs.Item(i), "GetTitle") or ""))
    except Exception as ex:
        print("GetDocuments", ex)
        titles = [str(call(sw.ActiveDoc, "GetTitle") or "")]
    print("open", titles)
    keep = "TavolaBoccolaFlangiata"
    for t in titles:
        if keep.lower() in t.lower():
            continue
        if not t:
            continue
        try:
            sw.CloseDoc(t)
            print("CloseDoc", t)
        except Exception as ex:
            print("CloseDoc fail", t, ex)
    print("active", call(sw.ActiveDoc, "GetTitle") if sw.ActiveDoc else None)


if __name__ == "__main__":
    main()
