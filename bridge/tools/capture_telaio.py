"""Cattura AssiemeTelaio / TavolaTelaio e copia gli still in media."""
from __future__ import annotations

import os
import shutil
import time

import pythoncom
import win32com.client

CAD = r"C:\Users\Carli\.ARCHIVIO\CADTM_BUSINESS\00_PROGETTI_3D\01_Progetti_Attivi\SolidworksIA\CAD"
DRAW = r"C:\Users\Carli\.ARCHIVIO\CADTM_BUSINESS\00_PROGETTI_3D\01_Progetti_Attivi\SolidworksIA\Disegni"
EXPORT = r"C:\Users\Carli\.ARCHIVIO\CADTM_BUSINESS\00_PROGETTI_3D\01_Progetti_Attivi\SolidworksIA\Export"
MEDIA = r"C:\Users\Carli\AppData\Local\Cursor\AgentStores\cursor_agent_stores\bc-70dc7761-0ccf-4f66-a8ad-40094baa66b8\files\media"
AGENT = r"C:\Users\Carli\AppData\Local\Cursor\AgentStores\cursor_agent_stores\bc-b6ca3bc0-abc8-5688-a74e-4b89deefc85f\files\media"

swIso, swFront, swTop = 7, 1, 5


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


def save_jpg(model, dest, view_id=None):
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    if view_id is not None:
        call(model, "ShowNamedView2", "", view_id)
        time.sleep(0.3)
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
        print("  fail", dest)
        return False
    from PIL import Image

    img = Image.open(bmp)
    img.convert("RGB").save(dest, "JPEG", quality=90)
    img.close()
    try:
        os.remove(bmp)
    except OSError:
        pass
    print("  saved", dest, os.path.getsize(dest))
    return True


def main():
    pythoncom.CoInitialize()
    sw = win32com.client.GetObject(Class="SldWorks.Application")
    sw.Visible = True
    os.makedirs(EXPORT, exist_ok=True)
    os.makedirs(MEDIA, exist_ok=True)
    os.makedirs(AGENT, exist_ok=True)

    asm_path = os.path.join(CAD, "AssiemeTelaio.SLDASM")
    drw_path = os.path.join(DRAW, "TavolaTelaio.SLDDRW")
    asm = call(sw, "OpenDoc", asm_path, 2) if os.path.isfile(asm_path) else None
    if asm is None:
        asm = sw.ActiveDoc
    drw = None
    if asm is not None and call(asm, "GetType") == 2:
        shots = [
            (os.path.join(EXPORT, "AssiemeTelaio-iso.jpg"), swIso, "telaio-assieme-01.jpg"),
            (os.path.join(EXPORT, "AssiemeTelaio-front.jpg"), swFront, "telaio-assieme-02.jpg"),
            (os.path.join(EXPORT, "AssiemeTelaio-top.jpg"), swTop, "telaio-assieme-03.jpg"),
        ]
        for dest, vid, media_name in shots:
            if save_jpg(asm, dest, vid):
                for folder in (MEDIA, AGENT):
                    out = os.path.join(folder, media_name)
                    shutil.copyfile(dest, out)
                    print("  copied", out, os.path.getsize(out))

    if os.path.isfile(drw_path):
        drw = call(sw, "OpenDoc", drw_path, 3)
    if drw is None and sw.ActiveDoc is not None and call(sw.ActiveDoc, "GetType") == 3:
        drw = sw.ActiveDoc
    if drw is not None:
        dest = os.path.join(EXPORT, "TavolaTelaio-sheet.jpg")
        if save_jpg(drw, dest, None):
            for folder in (MEDIA, AGENT):
                out = os.path.join(folder, "tavola-iso-01.jpg")
                shutil.copyfile(dest, out)
                print("  copied", out, os.path.getsize(out))

    docs = call(sw, "GetDocuments") or []
    if not isinstance(docs, (list, tuple)):
        docs = [docs]
    keep = "TavolaTelaio" if drw is not None else "AssiemeTelaio"
    for d in list(docs):
        if d is None:
            continue
        t = str(call(d, "GetTitle") or "")
        if keep.lower() in t.lower():
            continue
        try:
            sw.CloseDoc(t)
            print("  CloseDoc", t)
        except Exception as ex:
            print("  CloseDoc fail", t, ex)
    print("done keep", call(sw.ActiveDoc, "GetTitle") if sw.ActiveDoc else None)


if __name__ == "__main__":
    main()
