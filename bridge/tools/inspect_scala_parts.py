"""Bbox e assi cilindri dei pezzi scala (parte, non assieme)."""
from __future__ import annotations

import json
import os

import pythoncom
import win32com.client

CAD = r"C:\Users\Carli\.ARCHIVIO\CADTM_BUSINESS\00_PROGETTI_3D\01_Progetti_Attivi\SolidworksIA\CAD"


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


def box_mm(model):
    try:
        b = call(model, "GetPartBox", True)
        d = list(b)
        return {
            "X": [round(d[0] * 1000, 2), round(d[3] * 1000, 2)],
            "Y": [round(d[1] * 1000, 2), round(d[4] * 1000, 2)],
            "Z": [round(d[2] * 1000, 2), round(d[5] * 1000, 2)],
        }
    except Exception as e:
        return {"error": str(e)}


def cylinders(model):
    out = []
    part = model
    bodies = call(part, "GetBodies2", 0, True) or []
    if not isinstance(bodies, (list, tuple)):
        bodies = [bodies]
    for body in bodies:
        if body is None:
            continue
        faces = call(body, "GetFaces") or []
        if not isinstance(faces, (list, tuple)):
            faces = [faces]
        for face in faces:
            if face is None:
                continue
            surf = call(face, "GetSurface")
            if surf is None:
                continue
            try:
                if not bool(call(surf, "IsCylinder")):
                    continue
            except Exception:
                continue
            cp = call(surf, "CylinderParams")
            try:
                p = list(cp)
            except Exception:
                continue
            if len(p) < 7:
                continue
            out.append({
                "origin_mm": [round(p[0] * 1000, 2), round(p[1] * 1000, 2), round(p[2] * 1000, 2)],
                "axis": [round(p[3], 4), round(p[4], 4), round(p[5], 4)],
                "R_mm": round(abs(p[6]) * 1000, 3),
            })
    return out


def main():
    pythoncom.CoInitialize()
    sw = win32com.client.GetObject(Class="SldWorks.Application")
    names = ["FiancataSx", "FiancataDx", "Scalino1", "Scalino2", "Piede"]
    report = []
    for name in names:
        path = os.path.join(CAD, name + ".SLDPRT")
        model = call(sw, "OpenDoc", path, 1)
        if model is None:
            report.append({"name": name, "error": "open"})
            continue
        report.append({
            "name": name,
            "title": call(model, "GetTitle"),
            "box": box_mm(model),
            "cylinders": cylinders(model),
        })
        try:
            sw.CloseDoc(call(model, "GetTitle"))
        except Exception:
            pass
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
