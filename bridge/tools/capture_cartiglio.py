"""Cattura TavolaTelaio dalla GUI: foglio intero + zoom cartiglio CM.

Scrive file NUOVI (non sovrascrive tavola-iso-01.jpg):
  tavola-cartiglio-cm-01.jpg  foglio intero
  tavola-cartiglio-cm-02.jpg  crop basso-destra (logo CM / campi CADTM)
"""
from __future__ import annotations

import ctypes
import os
import time

import win32gui
import win32ui
from PIL import Image

EXPORT = r"C:\Users\Carli\.ARCHIVIO\CADTM_BUSINESS\00_PROGETTI_3D\01_Progetti_Attivi\SolidworksIA\Export"
MEDIA = r"C:\Users\Carli\AppData\Local\Cursor\AgentStores\cursor_agent_stores\bc-70dc7761-0ccf-4f66-a8ad-40094baa66b8\files\media"
AGENT = r"C:\Users\Carli\AppData\Local\Cursor\AgentStores\cursor_agent_stores\bc-b6ca3bc0-abc8-5688-a74e-4b89deefc85f\files\media"
PW_RENDERFULLCONTENT = 2


def find_sw_hwnd():
    found = []

    def cb(hwnd, _):
        if not win32gui.IsWindowVisible(hwnd):
            return True
        t = win32gui.GetWindowText(hwnd) or ""
        if "TavolaTelaio" in t and "SOLIDWORKS" in t.upper():
            found.append(hwnd)
        return True

    win32gui.EnumWindows(cb, None)
    return found[0] if found else None


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


def main():
    hwnd = find_sw_hwnd()
    if hwnd is None:
        raise SystemExit("Finestra TavolaTelaio non trovata")
    win32gui.ShowWindow(hwnd, 9)
    try:
        win32gui.SetForegroundWindow(hwnd)
    except Exception:
        pass
    time.sleep(0.5)
    img = print_window(hwnd)
    cw, ch = img.size
    zoom = img.crop((int(cw * 0.52), int(ch * 0.48), cw - 6, ch - 42))
    names = {
        "tavola-cartiglio-cm-01.jpg": img,
        "tavola-cartiglio-cm-02.jpg": zoom,
    }
    for folder in (EXPORT, MEDIA, AGENT):
        os.makedirs(folder, exist_ok=True)
        for name, im in names.items():
            dest = os.path.join(folder, name)
            im.save(dest, "JPEG", quality=92)
            n = os.path.getsize(dest)
            print("ok" if n > 0 else "FAIL", n, dest)


if __name__ == "__main__":
    main()
