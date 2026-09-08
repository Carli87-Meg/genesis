using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

namespace SolidWorksBridge;

internal sealed partial class PayloadExecutor
{
    private void EnableVisibleDimensions(ModelDoc2 model)
    {
        foreach (var pref in new[]
                 {
                     (int)swUserPreferenceToggle_e.swInputDimValOnCreate,
                 })
        {
            try { _sw?.SetUserPreferenceToggle(pref, false); } catch { /* ignore */ }
        }

        foreach (var pref in new[]
                 {
                     (int)swUserPreferenceToggle_e.swDisplayAnnotations,
                     (int)swUserPreferenceToggle_e.swDisplayFeatureDimensions,
                     (int)swUserPreferenceToggle_e.swDisplayReferenceDimensions,
                     (int)swUserPreferenceToggle_e.swDisplayAllAnnotations,
                 })
        {
            try { model.SetUserPreferenceToggle(pref, true); } catch { /* ignore */ }
            try { _sw?.SetUserPreferenceToggle(pref, true); } catch { /* ignore */ }
        }

        try { model.SetUserPreferenceToggle((int)swUserPreferenceToggle_e.swHideShowSketchDimensions, false); }
        catch { /* ignore */ }
    }

    private int DimensionRectangle(ModelDoc2 model, object? created, double cx, double cy, double w, double h)
    {
        var segs = SegmentsFrom(created);
        if (segs.Count < 2)
        {
            segs = ActiveSketchSegments(model);
        }

        ISketchSegment? h1 = null, h2 = null, v1 = null, v2 = null;
        foreach (var s in segs)
        {
            double x1, y1, x2, y2;
            if (!TryLineEnds(s, out x1, out y1, out x2, out y2)) continue;
            if (Math.Abs(x2 - x1) >= Math.Abs(y2 - y1))
            {
                if (h1 is null) h1 = s;
                else h2 = s;
            }
            else
            {
                if (v1 is null) v1 = s;
                else v2 = s;
            }
        }

        var n = 0;
        // Two vertical lines → width (horizontal dim)
        if (AddDistanceDim(model, v1, v2, cx, cy - h / 2 - 0.012, horizontal: true))
        {
            n++;
            Step("AddDimension2", true, $"width={w * 1000:0.##} mm");
        }

        // Two horizontal lines → height (vertical dim)
        if (AddDistanceDim(model, h1, h2, cx + w / 2 + 0.012, cy, horizontal: false))
        {
            n++;
            Step("AddDimension2", true, $"height={h * 1000:0.##} mm");
        }

        if (n == 0)
        {
            n += DimensionByCorners(model, cx, cy, w, h);
        }

        return n;
    }

    private int DimensionCircle(ModelDoc2 model, ISketchSegment? circle, double cx, double cy, double r)
    {
        if (circle is null)
        {
            circle = ActiveSketchSegments(model).LastOrDefault();
        }

        if (circle is null) return 0;
        try { model.ClearSelection2(true); } catch { /* ignore */ }
        try
        {
            if (!circle.Select4(false, null)) return 0;
        }
        catch
        {
            return 0;
        }

        object? dim = null;
        try { dim = model.AddDiameterDimension2(cx + r + 0.012, cy, 0); }
        catch
        {
            try { dim = model.AddDimension2(cx + r + 0.012, cy, 0); } catch { /* ignore */ }
        }

        var ok = dim is not null;
        Step("AddDimension2", ok, $"diameter={r * 2000:0.##} mm");
        RevealDimension(dim);
        return ok ? 1 : 0;
    }

    private int DimensionByCorners(ModelDoc2 model, double cx, double cy, double w, double h)
    {
        var n = 0;
        var x1 = cx - w / 2;
        var y1 = cy - h / 2;
        var x2 = cx + w / 2;
        var y2 = cy + h / 2;
        if (DimensionTwoPoints(model, x1, y1, x2, y1, cx, y1 - 0.012, horizontal: true))
        {
            n++;
            Step("AddDimension2", true, $"width(points)={w * 1000:0.##} mm");
        }

        if (DimensionTwoPoints(model, x2, y1, x2, y2, x2 + 0.012, cy, horizontal: false))
        {
            n++;
            Step("AddDimension2", true, $"height(points)={h * 1000:0.##} mm");
        }

        return n;
    }

    private bool DimensionTwoPoints(
        ModelDoc2 model,
        double ax, double ay, double bx, double by,
        double dimX, double dimY,
        bool horizontal)
    {
        try { model.ClearSelection2(true); } catch { /* ignore */ }
        if (!SelectSketchPoint(model, ax, ay, append: false)) return false;
        if (!SelectSketchPoint(model, bx, by, append: true)) return false;
        object? dim = null;
        try
        {
            dim = horizontal
                ? model.AddHorizontalDimension2(dimX, dimY, 0)
                : model.AddVerticalDimension2(dimX, dimY, 0);
        }
        catch
        {
            try { dim = model.AddDimension2(dimX, dimY, 0); } catch { return false; }
        }

        RevealDimension(dim);
        return dim is not null;
    }

    private bool AddDistanceDim(
        ModelDoc2 model,
        ISketchSegment? a,
        ISketchSegment? b,
        double x,
        double y,
        bool horizontal)
    {
        if (a is null || b is null) return false;
        try { model.ClearSelection2(true); } catch { /* ignore */ }
        try
        {
            if (!a.Select4(false, null) || !b.Select4(true, null)) return false;
        }
        catch
        {
            return false;
        }

        object? dim = null;
        try
        {
            dim = horizontal
                ? model.AddHorizontalDimension2(x, y, 0)
                : model.AddVerticalDimension2(x, y, 0);
        }
        catch
        {
            try { dim = model.AddDimension2(x, y, 0); } catch { return false; }
        }

        RevealDimension(dim);
        return dim is not null;
    }

    private static bool SelectSketchPoint(ModelDoc2 model, double x, double y, bool append)
    {
        try
        {
            var ext = (IModelDocExtension)model.Extension;
            return ext.SelectByID2("", "EXTSKETCHPOINT", x, y, 0, append, 0, null, 0);
        }
        catch
        {
            return false;
        }
    }

    private static List<ISketchSegment> SegmentsFrom(object? created)
    {
        var list = new List<ISketchSegment>();
        foreach (var obj in AsArray(created) ?? [])
        {
            if (obj is ISketchSegment s) list.Add(s);
        }

        if (created is ISketchSegment one) list.Add(one);
        return list;
    }

    private static List<ISketchSegment> ActiveSketchSegments(ModelDoc2 model)
    {
        try
        {
            if (model.GetActiveSketch2() is not ISketch sk) return [];
            return AsArray(sk.GetSketchSegments())?.OfType<ISketchSegment>().ToList() ?? [];
        }
        catch
        {
            return [];
        }
    }

    private static bool TryLineEnds(ISketchSegment seg, out double x1, out double y1, out double x2, out double y2)
    {
        x1 = y1 = x2 = y2 = 0;
        try
        {
            if (seg is not ISketchLine line) return false;
            if (line.GetStartPoint2() is not ISketchPoint a) return false;
            if (line.GetEndPoint2() is not ISketchPoint b) return false;
            x1 = a.X; y1 = a.Y;
            x2 = b.X; y2 = b.Y;
            return true;
        }
        catch
        {
            return false;
        }
    }

    private static void RevealDimension(object? dim)
    {
        if (dim is null) return;
        try
        {
            if (dim is IDisplayDimension dd)
            {
                dd.ShowDimensionValue = true;
                try { dd.MarkedForDrawing = true; } catch { /* ignore */ }
                if (dd.GetAnnotation() is IAnnotation ann)
                {
                    try { ann.Visible = (int)swAnnotationVisibilityState_e.swAnnotationVisible; } catch { /* ignore */ }
                }
            }
        }
        catch
        {
            /* ignore */
        }
    }

    private int CountDisplayDimensions(ModelDoc2 model)
    {
        var n = 0;
        try
        {
            var feat = (Feature)model.FirstFeature();
            while (feat is not null)
            {
                try
                {
                    var dd = feat.GetFirstDisplayDimension() as IDisplayDimension;
                    while (dd is not null)
                    {
                        n++;
                        dd = feat.GetNextDisplayDimension(dd) as IDisplayDimension;
                    }
                }
                catch
                {
                    /* feature without dims */
                }

                feat = feat.GetNextFeature() as Feature;
            }
        }
        catch
        {
            /* ignore */
        }

        return n;
    }
}
