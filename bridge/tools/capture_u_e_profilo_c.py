"""Cattura coperchio U + profilo C, nomi NUOVI."""
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
MEDIA = r"C:\Users\Carli\AppData\Local\Cursor\AgentStores\cursor_agent_stores\bc-70dc7761-0ccf-4f66-a8ad-40094baa66b8\files\media"
AGENT = r"C:\Users\Carli\AppData\Local\Cursor\AgentStores\cursor_agent_stores\bc-b6ca3bc0-abc8-5688-a74e-4b89deefc85f\files\media"
PW_RENDERFULLCONTENT = 2
swFront, swIso = 1, 7


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


def save_all(name, im):
    for folder in (EXPORT, MEDIA, AGENT):
        os.makedirs(folder, exist_ok=True)
        dest = os.path.join(folder, name)
        if isinstance(im, str):
            if os.path.abspath(im) == os.path.abspath(dest):
                print("same", dest, os.path.getsize(dest) if os.path.isfile(dest) else 0)
                continue
            shutil.copyfile(im, dest)
        else:
            im.save(dest, "JPEG", quality=92)
        n = os.path.getsize(dest)
        print("ok" if n > 0 else "FAIL", n, dest)


def save_view(model, dest, view_id):
    if view_id is not None:
        call(model, "ShowNamedView2", "", view_id)
        time.sleep(0.25)
    call(model, "ViewZoomtofit2")
    call(model, "GraphicsRedraw2")
    time.sleep(0.35)
    bmp = os.path.splitext(dest)[0] + ".bmp"
    if os.path.isfile(bmp):
        try:
            os.remove(bmp)
        except OSError:
            pass
    call(model, "SaveBMP", bmp, 1600, 1200)
    time.sleep(0.35)
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


def capture_drawing(prefer, tavola_name, cartiglio_name):
    hwnd, title = find_sw_hwnd(prefer)
    if hwnd is None:
        print("no hwnd", prefer)
        return
    print("hwnd", title)
    win32gui.ShowWindow(hwnd, win32con.SW_MAXIMIZE)
    time.sleep(0.5)
    try:
        win32gui.SetForegroundWindow(hwnd)
    except Exception:
        pass
    time.sleep(0.4)
    img = print_window(hwnd)
    print("img", img.size)
    cw, ch = img.size
    zoom = img.crop((int(cw * 0.55), int(ch * 0.52), cw - 8, ch - 48))
    save_all(tavola_name, img)
    save_all(cartiglio_name, zoom)


def main():
    copies = {
        "coperchio-u-iso-01.jpg": os.path.join(EXPORT, "Coperchio.jpg"),
        "coperchio-u-schizzo-base-01.jpg": os.path.join(EXPORT, "Coperchio-schizzo.jpg"),
        "coperchio-u-schizzo-fori-01.jpg": os.path.join(EXPORT, "Coperchio-schizzo-2.jpg"),
        "coperchio-u-schizzo-montante-01.jpg": os.path.join(EXPORT, "Coperchio-schizzo-3.jpg"),
        "profilo-c-iso-01.jpg": os.path.join(EXPORT, "ProfiloC80x40x3.jpg"),
        "profilo-c-schizzo-01.jpg": os.path.join(EXPORT, "ProfiloC80x40x3-schizzo.jpg"),
        "profilo-c-schizzo-fori-01.jpg": os.path.join(EXPORT, "ProfiloC80x40x3-schizzo-4.jpg"),
    }
    for name, src in copies.items():
        if os.path.isfile(src) and os.path.getsize(src) > 0:
            save_all(name, src)
        else:
            print("skip", src)

    pythoncom.CoInitialize()
    sw = win32com.client.GetObject(Class="SldWorks.Application")
    sw.Visible = True
    DRAW = r"C:\Users\Carli\.ARCHIVIO\CADTM_BUSINESS\00_PROGETTI_3D\01_Progetti_Attivi\SolidworksIA\Disegni"

    def open_doc(path, doc_type):
        model = None
        if os.path.isfile(path):
            try:
                model = sw.OpenDoc(path, doc_type)
            except Exception as ex:
                print("OpenDoc fail", path, ex)
        if model is None:
            return None
        title = call(model, "GetTitle") or os.path.basename(path)
        try:
            sw.ActivateDoc(title)
        except Exception:
            try:
                sw.ActivateDoc2(title, True, 0)
            except Exception as ex:
                print("Activate fail", title, ex)
        time.sleep(0.6)
        return model

    lid = os.path.join(CAD, "Coperchio.SLDPRT")
    model = open_doc(lid, 1)
    if model is not None:
        front = os.path.join(EXPORT, "coperchio-u-front-01.jpg")
        if save_view(model, front, swFront):
            save_all("coperchio-u-front-01.jpg", front)
        iso = os.path.join(EXPORT, "coperchio-u-iso-gui-01.jpg")
        if save_view(model, iso, swIso):
            save_all("coperchio-u-iso-gui-01.jpg", iso)

    c_part = open_doc(os.path.join(CAD, "ProfiloC80x40x3.SLDPRT"), 1)
    if c_part is not None:
        iso_c = os.path.join(EXPORT, "profilo-c-iso-gui-01.jpg")
        if save_view(c_part, iso_c, swIso):
            save_all("profilo-c-iso-gui-01.jpg", iso_c)

    tav_u = open_doc(os.path.join(DRAW, "TavolaCoperchio.SLDDRW"), 3)
    if tav_u is not None:
        dest = os.path.join(EXPORT, "coperchio-u-tavola-sheet.jpg")
        if save_view(tav_u, dest, None):
            save_all("coperchio-u-tavola-01.jpg", dest)
            try:
                from PIL import Image as PILImage

                img = PILImage.open(dest)
                w, h = img.size
                zoom = img.crop((int(w * 0.62), int(h * 0.62), w, h))
                save_all("coperchio-u-cartiglio-01.jpg", zoom)
            except Exception as ex:
                print("crop u", ex)
        capture_drawing("TavolaCoperchio", "coperchio-u-tavola-gui-01.jpg", "coperchio-u-cartiglio-gui-01.jpg")

    tav_c = open_doc(os.path.join(DRAW, "TavolaProfiloC.SLDDRW"), 3)
    if tav_c is not None:
        dest = os.path.join(EXPORT, "profilo-c-tavola-sheet.jpg")
        if save_view(tav_c, dest, None):
            save_all("profilo-c-tavola-01.jpg", dest)
            try:
                from PIL import Image as PILImage

                img = PILImage.open(dest)
                w, h = img.size
                zoom = img.crop((int(w * 0.62), int(h * 0.62), w, h))
                save_all("profilo-c-cartiglio-01.jpg", zoom)
            except Exception as ex:
                print("crop c", ex)
        capture_drawing("TavolaProfiloC", "profilo-c-tavola-gui-01.jpg", "profilo-c-cartiglio-gui-01.jpg")


if __name__ == "__main__":
    main()
