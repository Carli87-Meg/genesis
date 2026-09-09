"""Iso GUI della boccola: parte 3D, non schizzo."""
from __future__ import annotations

import os
import shutil
import time

import pythoncom
import win32com.client
import win32con
import win32gui

from capture_u_e_profilo_c import (
    AGENT,
    EXPORT,
    MEDIA,
    find_sw_hwnd,
    print_window,
    save_all,
)

CAD = r"C:\Users\Carli\.ARCHIVIO\CADTM_BUSINESS\00_PROGETTI_3D\01_Progetti_Attivi\SolidworksIA\CAD\BoccolaFlangiata.SLDPRT"
DRAW = r"C:\Users\Carli\.ARCHIVIO\CADTM_BUSINESS\00_PROGETTI_3D\01_Progetti_Attivi\SolidworksIA\Disegni\TavolaBoccolaFlangiata.SLDDRW"


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


def main():
    pythoncom.CoInitialize()
    sw = win32com.client.GetObject(Class="SldWorks.Application")
    sw.Visible = True
    model = call(sw, "OpenDoc", CAD, 1)
    title = call(model, "GetTitle")
    print("part", title, "type", call(model, "GetType"))
    try:
        sw.ActivateDoc(title)
    except Exception as ex:
        print("activate", ex)
    try:
        model.SketchManager.InsertSketch(False)
    except Exception:
        pass
    call(model, "ViewDisplayShaded")
    call(model, "ShowNamedView2", "", 7)
    call(model, "ViewZoomtofit2")
    for _ in range(5):
        call(model, "ViewZoomin")
    call(model, "GraphicsRedraw2")
    time.sleep(0.5)

    hwnd, wtitle = find_sw_hwnd("BoccolaFlangiata.SLDPRT")
    print("hwnd", wtitle)
    if hwnd:
        win32gui.ShowWindow(hwnd, win32con.SW_MAXIMIZE)
        time.sleep(0.4)
        try:
            win32gui.SetForegroundWindow(hwnd)
        except Exception:
            pass
        time.sleep(0.4)
        img = print_window(hwnd)
        print("img", img.size)
        save_all("boccola-flangiata-iso-01.jpg", img)

    try:
        sw.ActivateDoc("TavolaBoccolaFlangiata - Foglio1")
    except Exception:
        call(sw, "OpenDoc", DRAW, 3)
    try:
        sw.CloseDoc(title)
        print("closed part")
    except Exception as ex:
        print("close", ex)
    print("active", call(sw.ActiveDoc, "GetTitle") if sw.ActiveDoc else None)


if __name__ == "__main__":
    main()
