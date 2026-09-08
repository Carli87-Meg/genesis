using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

namespace SolidWorksBridge;

internal sealed partial class PayloadExecutor
{
    private void EnableVisibleDimensions(ModelDoc2 model)
    {
        TogglePref(model, (int)swUserPreferenceToggle_e.swInputDimValOnCreate, false);
        TogglePref(model, (int)swUserPreferenceToggle_e.swSketchCreateDimensionOnlyWhenEntered, false);
        TogglePref(model, (int)swUserPreferenceToggle_e.swViewDisplayHideAllTypes, false);
        TogglePref(model, (int)swUserPreferenceToggle_e.swAddDrivenDimensions, false);

        TogglePref(model, (int)swUserPreferenceToggle_e.swHideShowSketchDimensions, true);
        TogglePref(model, (int)swUserPreferenceToggle_e.swDisplayAnnotations, true);
        TogglePref(model, (int)swUserPreferenceToggle_e.swDisplayFeatureDimensions, true);
        TogglePref(model, (int)swUserPreferenceToggle_e.swDisplayReferenceDimensions, true);
        TogglePref(model, (int)swUserPreferenceToggle_e.swDisplayAllAnnotations, true);
        TogglePref(model, (int)swUserPreferenceToggle_e.swDisplaySketches, true);
        TogglePref(model, (int)swUserPreferenceToggle_e.swDisplayDimensionsFlatToScreen, true);
        TogglePref(model, (int)swUserPreferenceToggle_e.swAutoNormalToSketchMode, true);
        TogglePref(model, (int)swUserPreferenceToggle_e.swAddDimensionsToSketchEntity, true);
        TogglePref(model, (int)swUserPreferenceToggle_e.swAddDimensionsToLineEntity, true);
        TogglePref(model, (int)swUserPreferenceToggle_e.swAddDimensionsToRectangleEntity, true);
        TogglePref(model, (int)swUserPreferenceToggle_e.swAddDimensionsToArcEntity, true);
        TogglePref(model, (int)swUserPreferenceToggle_e.swAddDimensionsToCircleEntity, true);
        TogglePref(model, (int)swUserPreferenceToggle_e.swAddDimensionsToSlotEntity, true);

        EnlargeDimensionText(model);
    }

    private void TogglePref(ModelDoc2 model, int pref, bool on)
    {
        try { _sw?.SetUserPreferenceToggle(pref, on); } catch { /* ignore */ }
        try { model.SetUserPreferenceToggle(pref, on); } catch { /* ignore */ }
        try { ((IModelDocExtension)model.Extension).SetUserPreferenceToggle(pref, 0, on); }
        catch { /* ignore */ }
    }

    private static void EnlargeDimensionText(ModelDoc2 model)
    {
        try
        {
            var ext = (IModelDocExtension)model.Extension;
            var tf = ext.GetUserPreferenceTextFormat(
                (int)swUserPreferenceTextFormat_e.swDetailingDimensionTextFormat,
                (int)swUserPreferenceOption_e.swDetailingNoOptionSpecified);
            if (tf is null) return;
            try { tf.CharHeight = 0.004; } catch { /* ignore */ }
            try { tf.WidthFactor = 1.0; } catch { /* ignore */ }
            ext.SetUserPreferenceTextFormat(
                (int)swUserPreferenceTextFormat_e.swDetailingDimensionTextFormat,
                (int)swUserPreferenceOption_e.swDetailingNoOptionSpecified,
                tf);
        }
        catch
        {
            /* optional */
        }
    }

    /// <summary>
    /// Native SolidWorks quoting: FullyDefineSketch, then AddDimension2 / diametri / offset origine.
    /// Sempre sullo schizzo ATTIVO — non sull'ultimo ProfileFeature dell'albero (il secondo
    /// schizzo, es. fori dopo estrusione, veniva saltato perché il primo aveva già quote).
    /// </summary>
    private int QuoteActiveSketch(ModelDoc2 model, ISketchManager sketchMgr)
    {
        try { sketchMgr.AddToDB = false; } catch { /* ignore */ }
        try { sketchMgr.DisplayWhenAdded = true; } catch { /* ignore */ }
        try { sketchMgr.AutoSolve = true; } catch { /* ignore */ }
        EnableVisibleDimensions(model);

        TryFullyDefineSketch(sketchMgr);
        var n = CountSketchFeatureDims(model);
        n += DimensionAllSegments(model);
        n += DimensionCentersFromOrigin(model);

        RevealAllDisplayDimensions(model);
        try { model.GraphicsRedraw2(); } catch { /* ignore */ }
        n = Math.Max(n, CountSketchFeatureDims(model));
        return n;
    }

    private void TryFullyDefineSketch(ISketchManager sketchMgr)
    {
        var relations =
            (int)swSketchFullyDefineRelationType_e.swSketchFullyDefineRelationType_Equal
            | (int)swSketchFullyDefineRelationType_e.swSketchFullyDefineRelationType_Horizontal
            | (int)swSketchFullyDefineRelationType_e.swSketchFullyDefineRelationType_Vertical
            | (int)swSketchFullyDefineRelationType_e.swSketchFullyDefineRelationType_Tangent
            | (int)swSketchFullyDefineRelationType_e.swSketchFullyDefineRelationType_Perpendicular
            | (int)swSketchFullyDefineRelationType_e.swSketchFullyDefineRelationType_Colinear
            | (int)swSketchFullyDefineRelationType_e.swSketchFullyDefineRelationType_Concentric
            | (int)swSketchFullyDefineRelationType_e.swSketchFullyDefineRelationType_Parallel
            | (int)swSketchFullyDefineRelationType_e.swSketchFullyDefineRelationType_Midpoint
            | (int)swSketchFullyDefineRelationType_e.swSketchFullyDefineRelationType_Coincident;
        try
        {
            var n = sketchMgr.FullyDefineSketch(
                true,
                true,
                relations,
                true,
                (int)swAutodimScheme_e.swAutodimSchemeBaseline,
                null!,
                (int)swAutodimScheme_e.swAutodimSchemeBaseline,
                null!,
                (int)swAutodimHorizontalPlacement_e.swAutodimHorizontalPlacementBelow,
                (int)swAutodimVerticalPlacement_e.swAutodimVerticalPlacementRight);
            Step("FullyDefineSketch", true, $"result={n}");
        }
        catch (Exception ex)
        {
            Step("FullyDefineSketch", false, FormatEx(ex));
        }
    }

    private int DimensionAllSegments(ModelDoc2 model)
    {
        var segs = ActiveSketchSegments(model);
        var n = 0;
        var lines = new List<ISketchSegment>();
        foreach (var s in segs)
        {
            int t;
            try { t = s.GetType(); }
            catch { continue; }

            if (t == (int)swSketchSegments_e.swSketchLINE)
            {
                lines.Add(s);
                continue;
            }

            if (t is (int)swSketchSegments_e.swSketchARC or (int)swSketchSegments_e.swSketchELLIPSE)
            {
                double cx = 0, cy = 0, r = 0;
                if (TryCircle(s, out cx, out cy, out r))
                {
                    n += DimensionCircle(model, s, cx, cy, r);
                }
            }
        }

        if (lines.Count >= 4)
        {
            double minX = double.MaxValue, minY = double.MaxValue, maxX = double.MinValue, maxY = double.MinValue;
            foreach (var s in lines)
            {
                if (!TryLineEnds(s, out var x1, out var y1, out var x2, out var y2)) continue;
                minX = Math.Min(minX, Math.Min(x1, x2));
                maxX = Math.Max(maxX, Math.Max(x1, x2));
                minY = Math.Min(minY, Math.Min(y1, y2));
                maxY = Math.Max(maxY, Math.Max(y1, y2));
            }

            var w = maxX - minX;
            var h = maxY - minY;
            if (w > 1e-8 && h > 1e-8)
            {
                n += DimensionRectangle(model, lines, (minX + maxX) / 2, (minY + maxY) / 2, w, h);
            }
        }
        else if (lines.Count == 1)
        {
            var s = lines[0];
            try
            {
                model.ClearSelection2(true);
                s.Select4(false, null);
                if (TryLineEnds(s, out var x1, out var y1, out var x2, out var y2))
                {
                    var dim = model.AddDimension2((x1 + x2) / 2 + 0.008, (y1 + y2) / 2 + 0.008, 0);
                    if (dim is not null)
                    {
                        n++;
                        RevealDimension(dim);
                        Step("AddDimension2", true, "line");
                    }
                }
            }
            catch
            {
                /* optional */
            }
        }

        return n;
    }

    /// <summary>
    /// Quote di officina: centro foro rispetto all'origine schizzo (X e Y).
    /// AddDimension2 restituisce null se la quota esiste già (niente sovra-definizione).
    /// </summary>
    private int DimensionCentersFromOrigin(ModelDoc2 model)
    {
        var n = 0;
        foreach (var s in ActiveSketchSegments(model))
        {
            int t;
            try { t = s.GetType(); }
            catch { continue; }
            if (t != (int)swSketchSegments_e.swSketchARC && t != (int)swSketchSegments_e.swSketchELLIPSE)
                continue;
            if (!TryCircle(s, out var cx, out var cy, out var r)) continue;

            ISketchPoint? center = null;
            try { center = (s as ISketchArc)?.GetCenterPoint2() as ISketchPoint; }
            catch { /* ignore */ }

            if (Math.Abs(cx) > 1e-7)
            {
                if (AddCenterToOriginDim(model, center, cx, cy, r, horizontal: true))
                {
                    n++;
                    Step("AddDimension2", true, $"foro X={cx * 1000:0.##} mm");
                }
            }

            if (Math.Abs(cy) > 1e-7)
            {
                if (AddCenterToOriginDim(model, center, cx, cy, r, horizontal: false))
                {
                    n++;
                    Step("AddDimension2", true, $"foro Y={cy * 1000:0.##} mm");
                }
            }
        }

        return n;
    }

    private bool AddCenterToOriginDim(
        ModelDoc2 model,
        ISketchPoint? center,
        double cx,
        double cy,
        double r,
        bool horizontal)
    {
        try { model.ClearSelection2(true); } catch { /* ignore */ }
        if (!SelectOrigin(model, append: false)) return false;
        var gotCenter = false;
        try
        {
            if (center is not null) gotCenter = center.Select4(true, null);
        }
        catch { /* ignore */ }
        if (!gotCenter && !SelectSketchPoint(model, cx, cy, append: true)) return false;

        var dimX = horizontal ? cx / 2.0 : cx + r + 0.012;
        var dimY = horizontal ? cy + r + 0.012 : cy / 2.0;
        object? dim = null;
        try
        {
            dim = horizontal
                ? model.AddHorizontalDimension2(dimX, dimY, 0)
                : model.AddVerticalDimension2(dimX, dimY, 0);
        }
        catch
        {
            try { dim = model.AddDimension2(dimX, dimY, 0); }
            catch { return false; }
        }

        RevealDimension(dim);
        return dim is not null;
    }

    private static bool SelectOrigin(ModelDoc2 model, bool append)
    {
        try
        {
            var ext = (IModelDocExtension)model.Extension;
            if (ext.SelectByID2("", "EXTSKETCHPOINT", 0, 0, 0, append, 0, null, 0)) return true;
            if (ext.SelectByID2("Point1", "SKETCHPOINT", 0, 0, 0, append, 0, null, 0)) return true;
            if (ext.SelectByID2("Punto1", "SKETCHPOINT", 0, 0, 0, append, 0, null, 0)) return true;
        }
        catch { /* ignore */ }
        return SelectSketchPoint(model, 0, 0, append);
    }

    private static bool TryCircle(ISketchSegment seg, out double cx, out double cy, out double r)
    {
        cx = cy = r = 0;
        try
        {
            if (seg is not ISketchArc arc) return false;
            if (arc.GetCenterPoint2() is not ISketchPoint c) return false;
            cx = c.X;
            cy = c.Y;
            try { r = arc.GetRadius(); }
            catch
            {
                try { r = ((ISketchArc)seg).GetRadius(); }
                catch { r = 0; }
            }
            return r > 1e-9;
        }
        catch
        {
            return false;
        }
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
        if (created is IEnumerable<ISketchSegment> typed)
        {
            list.AddRange(typed);
            return list;
        }

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
            IDisplayDimension? dd = dim as IDisplayDimension;
            if (dd is null && dim is DisplayDimension boxed) dd = boxed;
            if (dd is null) return;
            try { dd.ShowDimensionValue = true; } catch { /* ignore */ }
            try { dd.MarkedForDrawing = true; } catch { /* ignore */ }
            try
            {
                if (dd.GetAnnotation() is IAnnotation ann)
                {
                    ann.Visible = (int)swAnnotationVisibilityState_e.swAnnotationVisible;
                    /* visible is enough for SaveBMP */
                }
            }
            catch
            {
                /* ignore */
            }
        }
        catch
        {
            /* ignore */
        }
    }

    private void RevealAllDisplayDimensions(ModelDoc2 model)
    {
        foreach (var feat in WalkFeatures(model))
        {
            try
            {
                var dd = feat.GetFirstDisplayDimension() as IDisplayDimension;
                while (dd is not null)
                {
                    RevealDimension(dd);
                    dd = feat.GetNextDisplayDimension(dd) as IDisplayDimension;
                }
            }
            catch
            {
                /* feature without dims */
            }
        }
    }

    private int CountSketchFeatureDims(ModelDoc2 model)
    {
        ISketch? active = null;
        try { active = model.GetActiveSketch2() as ISketch; }
        catch { active = null; }

        if (active is not null)
        {
            foreach (var feat in WalkFeatures(model))
            {
                string tn;
                try { tn = feat.GetTypeName2(); }
                catch { continue; }
                if (tn is not "ProfileFeature") continue;
                try
                {
                    if (feat.GetSpecificFeature2() is ISketch sk && SketchesEqual(sk, active))
                        return CountDimsOn(feat);
                }
                catch { /* next */ }
            }

            // Schizzo in creazione: non è ancora (o non matcha) un nodo albero.
            // NON usare l'ultimo ProfileFeature — appartiene al pezzo precedente.
            return 0;
        }

        Feature? last = null;
        foreach (var feat in WalkFeatures(model))
        {
            string tn;
            try { tn = feat.GetTypeName2(); }
            catch { tn = ""; }
            if (tn is "ProfileFeature") last = feat;
        }

        return last is null ? 0 : CountDimsOn(last);
    }

    private static bool SketchesEqual(ISketch a, ISketch b)
    {
        try { if (ReferenceEquals(a, b)) return true; } catch { /* ignore */ }
        try { return Equals(a, b); } catch { return false; }
    }

    private int CountDisplayDimensions(ModelDoc2 model)
    {
        var n = 0;
        var sketch = 0;
        foreach (var feat in WalkFeatures(model))
        {
            var c = CountDimsOn(feat);
            n += c;
            string tn;
            try { tn = feat.GetTypeName2(); }
            catch { tn = ""; }
            if (tn is "ProfileFeature") sketch += c;
        }

        if (sketch > 0)
        {
            Step("SketchDisplayDims", true, $"{sketch} quote su schizzi");
        }

        return n;
    }

    private static int CountDimsOn(Feature feat)
    {
        var n = 0;
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
            return n;
        }

        return n;
    }

    private void QuoteAllProfileFeatures(ModelDoc2 model)
    {
        if (model.GetType() != (int)swDocumentTypes_e.swDocPART) return;
        var sketches = new List<Feature>();
        foreach (var feat in WalkFeatures(model))
        {
            string tn;
            try { tn = feat.GetTypeName2(); }
            catch { continue; }
            if (tn is "ProfileFeature") sketches.Add(feat);
        }

        var sketchMgr = (ISketchManager)model.SketchManager;
        foreach (var feat in sketches)
        {
            try
            {
                EnableVisibleDimensions(model);
                model.ClearSelection2(true);
                feat.Select2(false, 0);
                model.EditSketch();
                try { model.ShowNamedView2("*Normale a", -1); } catch { /* ignore */ }
                try { model.ViewZoomtofit2(); } catch { /* ignore */ }
                try { sketchMgr.AddToDB = false; } catch { /* ignore */ }
                try { sketchMgr.DisplayWhenAdded = true; } catch { /* ignore */ }
                var n = QuoteActiveSketch(model, sketchMgr);
                CaptureQuotedSketch(model);
                sketchMgr.InsertSketch(false);
                Step("QuoteProfile", n > 0, $"{feat.Name}: {n} quote");
            }
            catch (Exception ex)
            {
                Step("QuoteProfile", false, $"{feat.Name}: {FormatEx(ex)}");
                try { sketchMgr.InsertSketch(false); } catch { /* ignore */ }
            }
        }
    }

    private static IEnumerable<Feature> WalkFeatures(ModelDoc2 model)
    {
        Feature? feat;
        try { feat = (Feature)model.FirstFeature(); }
        catch { yield break; }

        while (feat is not null)
        {
            yield return feat;
            Feature? next;
            try { next = feat.GetNextFeature() as Feature; }
            catch { yield break; }
            feat = next;
        }
    }
}
