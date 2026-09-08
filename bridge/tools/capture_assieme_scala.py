"""Cattura viste AssiemeScala e chiude i documenti extra."""
from __future__ import annotations

import os
import shutil
import time

import pythoncom
import win32com.client

CAD = r"C:\Users\Carli\.ARCHIVIO\CADTM_BUSINESS\00_PROGETTI_3D\01_Progetti_Attivi\SolidworksIA\CAD"
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


def save_jpg(model, dest, view_id):
    os.makedirs(os.path.dirname(dest), exist_ok=True)
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
    path = os.path.join(CAD, "AssiemeScala.SLDASM")
    model = call(sw, "OpenDoc", path, 2)
    if model is None:
        model = sw.ActiveDoc
    title = call(model, "GetTitle")
    print("active", title, "type", call(model, "GetType"))
    os.makedirs(EXPORT, exist_ok=True)
    shots = [
        (os.path.join(EXPORT, "AssiemeScala-iso.jpg"), swIso, "scala-assieme-01.jpg"),
        (os.path.join(EXPORT, "AssiemeScala-front.jpg"), swFront, "scala-assieme-02.jpg"),
        (os.path.join(EXPORT, "AssiemeScala-top.jpg"), swTop, "scala-assieme-03.jpg"),
    ]
    os.makedirs(MEDIA, exist_ok=True)
    os.makedirs(AGENT, exist_ok=True)
    for dest, vid, media_name in shots:
        if save_jpg(model, dest, vid):
            for folder in (MEDIA, AGENT):
                out = os.path.join(folder, media_name)
                shutil.copyfile(dest, out)
                print("  copied", out, os.path.getsize(out), os.path.isfile(out))

    docs = call(sw, "GetDocuments") or []
    if not isinstance(docs, (list, tuple)):
        docs = [docs]
    keep = "AssiemeScala"
    for d in list(docs):
        if d is None:
            continue
        t = call(d, "GetTitle") or ""
        if keep.lower() in str(t).lower():
            continue
        try:
            sw.CloseDoc(t)
            print("  CloseDoc", t)
        except Exception as ex:
            print("  CloseDoc fail", t, ex)
    print("done keep", call(sw.ActiveDoc, "GetTitle") if sw.ActiveDoc else None)


if __name__ == "__main__":
    main()
