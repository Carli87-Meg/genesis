"""Cattura GUI TavolaPiastraPerno + still schizzi, nomi NUOVI."""
from __future__ import annotations

import ctypes
import os
import shutil
import time

import win32con
import win32gui
import win32ui
from PIL import Image

EXPORT = r"C:\Users\Carli\.ARCHIVIO\CADTM_BUSINESS\00_PROGETTI_3D\01_Progetti_Attivi\SolidworksIA\Export"
MEDIA = r"C:\Users\Carli\AppData\Local\Cursor\AgentStores\cursor_agent_stores\bc-70dc7761-0ccf-4f66-a8ad-40094baa66b8\files\media"
AGENT = r"C:\Users\Carli\AppData\Local\Cursor\AgentStores\cursor_agent_stores\bc-b6ca3bc0-abc8-5688-a74e-4b89deefc85f\files\media"
PW_RENDERFULLCONTENT = 2


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
            shutil.copyfile(im, dest)
        else:
            im.save(dest, "JPEG", quality=92)
        n = os.path.getsize(dest)
        print("ok" if n > 0 else "FAIL", n, dest)


def main():
    copies = {
        "piastra-perno-iso-01.jpg": os.path.join(EXPORT, "AssiemePiastraPerno.jpg"),
        "piastra-perno-schizzo-base-01.jpg": os.path.join(EXPORT, "Piastra90-schizzo.jpg"),
        "piastra-perno-schizzo-fori-01.jpg": os.path.join(EXPORT, "Piastra90-schizzo-2.jpg"),
        "piastra-perno-schizzo-perno-01.jpg": os.path.join(EXPORT, "PernoCilindrico-schizzo.jpg"),
    }
    for name, src in copies.items():
        if not os.path.isfile(src) or os.path.getsize(src) <= 0:
            raise SystemExit(f"manca {src}")
        save_all(name, src)

    hwnd, title = find_sw_hwnd("TavolaPiastraPerno")
    if hwnd is None:
        raise SystemExit("Finestra SOLIDWORKS non trovata")
    print("hwnd", title)
    win32gui.ShowWindow(hwnd, win32con.SW_MAXIMIZE)
    time.sleep(0.6)
    try:
        win32gui.SetForegroundWindow(hwnd)
    except Exception:
        pass
    time.sleep(0.4)
    img = print_window(hwnd)
    print("img", img.size)
    if img.size[0] < 200:
        raise SystemExit(f"rect piccolo {img.size}")
    cw, ch = img.size
    zoom = img.crop((int(cw * 0.55), int(ch * 0.52), cw - 8, ch - 48))
    save_all("piastra-perno-tavola-01.jpg", img)
    save_all("piastra-perno-cartiglio-01.jpg", zoom)


if __name__ == "__main__":
    main()
