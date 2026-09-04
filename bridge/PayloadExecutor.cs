using System.Globalization;
using System.Runtime.InteropServices;
using System.Text.Json;

namespace SolidWorksBridge;

internal sealed class PayloadExecutor
{
    private const int SwDocPart = 1;
    private const int SwDocAssembly = 2;
    private const int SwDocDrawing = 3;
    private const int SwEndCondBlind = 0;
    private const int SwEndCondThroughAll = 1;
    private const int SwMateCoincident = 0;
    private const int SwMateConcentric = 1;
    private const int SwMatePerpendicular = 3;
    private const int SwMateParallel = 2;
    private const int SwMateDistance = 5;

    private readonly List<ExecStep> _steps = [];
    private readonly Dictionary<string, string> _created = new(StringComparer.OrdinalIgnoreCase);

    public (List<ExecStep> Steps, List<FeatureInfo> Features, string? DocTitle, int? DocType) Execute(
        object swAppObj,
        SolidWorksDocumentPayload payload)
    {
        dynamic swApp = swAppObj;
        _steps.Clear();
        _created.Clear();

        TrySet(swApp, "UserControlBackground", true);
        TrySet(swApp, "Visible", true);
        TrySet(swApp, "UserControl", true);
        TrySet(swApp, "CommandInProgress", true);
        // swInputDimValOnCreate — avoid blocking dimension dialogs
        TryCall(swApp, "SetUserPreferenceToggle", 10, false);

        dynamic? model = null;
        try
        {
            model = OpenDocument(swApp, payload.Document);
            if (model is null)
            {
                Step("OpenDocument", false, "ActiveDoc è null dopo NewDocument/GetObject");
                return (_steps, [], null, null);
            }

            ApplyVariables(model, payload.Variables);

            foreach (var op in payload.Operations)
            {
                try
                {
                    RunOperation(swApp, model, op, payload.Units);
                }
                catch (Exception ex)
                {
                    Step(op.Type, false, FormatEx(ex));
                }
            }

            ApplyConfigurations(model, payload.Configurations);

            try
            {
                model.ForceRebuild3(true);
                Step("ForceRebuild3", true, "Ricostruzione completata");
            }
            catch (Exception ex)
            {
                Step("ForceRebuild3", false, FormatEx(ex));
            }

            try
            {
                model.ViewZoomtofit2();
            }
            catch
            {
                /* optional */
            }

            string? title = null;
            int? docType = null;
            try { title = (string)model.GetTitle(); } catch { /* ignore */ }
            try { docType = (int)model.GetType(); } catch { /* ignore */ }

            var features = FeatureTreeReader.Read((object)model);
            Step("FeatureByPositionReverse", true, $"{features.Count} feature (GetTypeName2)");
            return (_steps, features, title, docType);
        }
        finally
        {
            TrySet(swApp, "CommandInProgress", false);
        }
    }

    private dynamic? OpenDocument(dynamic swApp, DocumentSpec spec)
    {
        var kind = (spec.Type ?? "part").Trim().ToLowerInvariant();

        if (spec.AttachToActive)
        {
            try
            {
                dynamic active = swApp.ActiveDoc;
                if (active is not null && active is not DBNull)
                {
                    Step("AttachToActive", true, (string)active.GetTitle());
                    return active;
                }

                Step("AttachToActive", false, "Nessun documento attivo");
            }
            catch (Exception ex)
            {
                Step("AttachToActive", false, FormatEx(ex));
            }
        }

        return kind switch
        {
            "assembly" or "assieme" => NewAssembly(swApp, spec.Name),
            "drawing" or "tavola" or "disegno" => NewDrawing(swApp, spec.Name),
            _ => NewPart(swApp, spec.Name),
        };
    }

    private dynamic? NewPart(dynamic swApp, string name)
    {
        var template = TemplateLocator.Part();
        object? doc = null;
        try
        {
            doc = swApp.NewDocument(template, 0, 0.0, 0.0);
            Step("NewDocument", doc is not null && doc is not DBNull, $"template={template}");
        }
        catch (Exception ex)
        {
            Step("NewDocument", false, FormatEx(ex));
        }

        if (doc is null || doc is DBNull)
        {
            try
            {
                doc = swApp.NewPart();
                Step("NewPart", doc is not null, "fallback NewPart()");
            }
            catch (Exception ex)
            {
                Step("NewPart", false, FormatEx(ex));
            }
        }

        RenameIfPossible(doc, name);
        return doc as dynamic ?? (dynamic?)doc;
    }

    private dynamic? NewAssembly(dynamic swApp, string name)
    {
        object? doc = null;
        try
        {
            doc = swApp.NewAssembly();
            Step("NewAssembly", doc is not null && doc is not DBNull, name);
        }
        catch (Exception ex)
        {
            Step("NewAssembly", false, FormatEx(ex));
        }

        if (doc is null || doc is DBNull)
        {
            var template = TemplateLocator.Assembly();
            try
            {
                doc = swApp.NewDocument(template, 0, 0.0, 0.0);
                Step("NewDocument", doc is not null, $"assembly template={template}");
            }
            catch (Exception ex)
            {
                Step("NewDocument", false, FormatEx(ex));
            }
        }

        RenameIfPossible(doc, name);
        return doc as dynamic ?? (dynamic?)doc;
    }

    private dynamic? NewDrawing(dynamic swApp, string name)
    {
        object? doc = null;
        var template = TemplateLocator.Drawing();
        try
        {
            // NewDrawing2(templateDir unused in some versions): paper A3 landscape-ish
            doc = swApp.NewDrawing2(2, template, 12, 0.42, 0.297);
            Step("NewDrawing", doc is not null && doc is not DBNull, $"template={template}");
        }
        catch (Exception ex)
        {
            Step("NewDrawing", false, FormatEx(ex));
            try
            {
                doc = swApp.NewDocument(template, 0, 0.42, 0.297);
                Step("NewDocument", doc is not null, "drawing via NewDocument");
            }
            catch (Exception ex2)
            {
                Step("NewDocument", false, FormatEx(ex2));
            }
        }

        RenameIfPossible(doc, name);
        return doc as dynamic ?? (dynamic?)doc;
    }

    private static void RenameIfPossible(object? doc, string name)
    {
        if (doc is null || doc is DBNull || string.IsNullOrWhiteSpace(name))
        {
            return;
        }

        try
        {
            dynamic model = doc;
            model.SetTitle2(name);
        }
        catch
        {
            /* title may require save */
        }
    }

    private void ApplyVariables(dynamic model, List<CadVariable> variables)
    {
        if (variables.Count == 0)
        {
            return;
        }

        try
        {
            dynamic eq = model.GetEquationMgr();
            foreach (var v in variables)
            {
                if (string.IsNullOrWhiteSpace(v.Name))
                {
                    continue;
                }

                var expr = $"\"{v.Name}\" = {v.Value.ToString(CultureInfo.InvariantCulture)}";
                try
                {
                    eq.Add2(-1, expr, true);
                    Step("EquationMgr.Add2", true, expr);
                }
                catch (Exception ex)
                {
                    Step("EquationMgr.Add2", false, $"{expr}: {FormatEx(ex)}");
                }
            }
        }
        catch (Exception ex)
        {
            Step("GetEquationMgr", false, FormatEx(ex));
        }
    }

    private void ApplyConfigurations(dynamic model, List<CadConfiguration> configs)
    {
        foreach (var cfg in configs)
        {
            if (string.IsNullOrWhiteSpace(cfg.Name))
            {
                continue;
            }

            try
            {
                var ok = model.AddConfiguration3(cfg.Name, "", "", 0);
                if (ok is null || ok is DBNull)
                {
                    model.AddConfiguration2(cfg.Name, "", "", 0);
                }

                Step("AddConfiguration2", true, cfg.Name);
            }
            catch (Exception ex)
            {
                try
                {
                    model.AddConfiguration(cfg.Name, "", "");
                    Step("AddConfiguration", true, cfg.Name);
                }
                catch
                {
                    Step("AddConfiguration2", false, FormatEx(ex));
                }
            }
        }
    }

    private void RunOperation(dynamic swApp, dynamic model, CadOperation op, string units)
    {
        var type = (op.Type ?? "").Trim().ToLowerInvariant();
        switch (type)
        {
            case "sketch":
                DoSketch(model, op, units);
                break;
            case "extrude":
                DoExtrude(model, op, units, cut: false);
                break;
            case "cut":
                DoExtrude(model, op, units, cut: true);
                break;
            case "revolve":
                DoRevolve(model, op);
                break;
            case "hole":
                DoHole(model, op, units);
                break;
            case "fillet":
                DoFillet(model, op, units);
                break;
            case "chamfer":
                DoChamfer(model, op, units);
                break;
            case "shell":
                DoShell(model, op, units);
                break;
            case "pattern":
                DoPattern(model, op, units);
                break;
            case "component":
                DoComponent(model, op, units);
                break;
            case "mate":
                DoMate(model, op, units);
                break;
            case "drawingview":
            case "drawing_view":
                DoDrawingView(model, op);
                break;
            case "annotation":
                DoAnnotation(model, op);
                break;
            default:
                Step(op.Type, false, "Tipo operazione non supportato");
                break;
        }
    }

    private void DoSketch(dynamic model, CadOperation op, string units)
    {
        var plane = op.Str("plane", "Top");
        if (!SelectPlane(model, plane))
        {
            Step("sketch", false, $"Piano non trovato: {plane}");
            return;
        }

        dynamic sketchMgr = model.SketchManager;
        sketchMgr.InsertSketch(true);
        TrySet(sketchMgr, "AddToDB", true);

        var contours = op.Field("contours");
        var n = 0;
        if (contours is { ValueKind: JsonValueKind.Array })
        {
            foreach (var c in contours.Value.EnumerateArray())
            {
                n += DrawContour(sketchMgr, c, units) ? 1 : 0;
            }
        }

        sketchMgr.InsertSketch(false);
        RememberLatest(model, op.Id, op.Name);
        Step("SketchManager", true, $"{n} contorni su {plane}");
    }

    private bool DrawContour(dynamic sketchMgr, JsonElement c, string units)
    {
        var kind = c.TryGetProperty("kind", out var k) ? k.GetString() ?? "" : "";
        try
        {
            switch (kind.ToLowerInvariant())
            {
                case "rectangle":
                {
                    var cx = Len(c, "cx", units);
                    var cy = Len(c, "cy", units);
                    var w = Len(c, "width", units);
                    var h = Len(c, "height", units);
                    var x1 = cx - w / 2;
                    var y1 = cy - h / 2;
                    var x2 = cx + w / 2;
                    var y2 = cy + h / 2;
                    sketchMgr.CreateCornerRectangle(x1, y1, 0, x2, y2, 0);
                    return true;
                }
                case "circle":
                {
                    var cx = Len(c, "cx", units);
                    var cy = Len(c, "cy", units);
                    var d = Len(c, "diameter", units);
                    var r = c.TryGetProperty("radius", out var rj) && rj.ValueKind == JsonValueKind.Number
                        ? ToMeters(rj.GetDouble(), units)
                        : d / 2;
                    try
                    {
                        sketchMgr.CreateCircleByRadius(cx, cy, 0, r);
                    }
                    catch
                    {
                        sketchMgr.CreateCircle(cx, cy, 0, cx + r, cy, 0);
                    }

                    return true;
                }
                case "line":
                {
                    var x1 = Len(c, "x1", units);
                    var y1 = Len(c, "y1", units);
                    var x2 = Len(c, "x2", units);
                    var y2 = Len(c, "y2", units);
                    var line = sketchMgr.CreateLine(x1, y1, 0, x2, y2, 0);
                    if (c.TryGetProperty("construction", out var cons) && cons.ValueKind == JsonValueKind.True)
                    {
                        try { line.ConstructionGeometry = true; } catch { /* ignore */ }
                    }

                    return true;
                }
                default:
                    return false;
            }
        }
        catch (Exception ex)
        {
            Step("SketchManager.Create", false, $"{kind}: {FormatEx(ex)}");
            return false;
        }
    }

    private void DoExtrude(dynamic model, CadOperation op, string units, bool cut)
    {
        var sketchId = op.Str("sketch");
        if (!string.IsNullOrEmpty(sketchId) && _created.TryGetValue(sketchId, out var sketchName))
        {
            SelectFeature(model, sketchName);
        }

        dynamic featMgr = model.FeatureManager;
        var depth = ToMeters(op.Num("depth", 10), units);
        var flip = op.Flag("flip");
        var merge = op.Flag("merge", true);
        var throughAll = op.Flag("throughAll");
        var t1 = throughAll ? SwEndCondThroughAll : SwEndCondBlind;

        object? feat = null;
        var api = cut ? "FeatureCut" : "FeatureExtrusion";
        try
        {
            if (cut)
            {
                try
                {
                    feat = featMgr.FeatureCut4(
                        true, flip, false, t1, SwEndCondBlind, depth, 0,
                        false, false, false, false, 0.0, 0.0,
                        false, false, false, false,
                        false, true, true, true, true, false,
                        0, 0, false, false);
                }
                catch
                {
                    feat = featMgr.FeatureCut3(
                        true, flip, false, t1, SwEndCondBlind, depth, 0,
                        false, false, false, false, 0.0, 0.0,
                        false, false, false, false,
                        false, true, true, true, true, false);
                }
            }
            else
            {
                try
                {
                    feat = featMgr.FeatureExtrusion3(
                        true, false, flip, t1, SwEndCondBlind, depth, 0,
                        false, false, false, false, 0.0, 0.0,
                        false, false, false, false,
                        merge, true, true, 0, 0.0, false,
                        false, false, false);
                }
                catch
                {
                    feat = featMgr.FeatureExtrusion2(
                        true, false, flip, t1, SwEndCondBlind, depth, 0,
                        false, false, false, false, 0.0, 0.0,
                        false, false, false, false,
                        merge, true, true, 0, 0.0, false);
                }
            }
        }
        catch (Exception ex)
        {
            Step(api, false, FormatEx(ex));
            return;
        }

        var ok = feat is not null && feat is not DBNull;
        if (ok)
        {
            RememberFeature(op.Id, op.Name, feat);
        }

        Step(cut ? "FeatureManager.FeatureCut" : "FeatureManager.FeatureExtrusion", ok,
            throughAll ? "throughAll" : $"depth={op.Num("depth")} {units}");
    }

    private void DoRevolve(dynamic model, CadOperation op)
    {
        var sketchId = op.Str("sketch");
        if (!string.IsNullOrEmpty(sketchId) && _created.TryGetValue(sketchId, out var sketchName))
        {
            SelectFeature(model, sketchName);
        }

        var angle = op.Num("angle", 360) * Math.PI / 180.0;
        try
        {
            dynamic featMgr = model.FeatureManager;
            object feat = featMgr.FeatureRevolve2(
                true, true, false, false, 0, 0,
                angle, 0, false, false, 0, 0,
                0, 0, 0, 0, true, true, true);
            RememberFeature(op.Id, op.Name, feat);
            Step("FeatureManager.FeatureRevolve2", feat is not null, $"angle={op.Num("angle", 360)}°");
        }
        catch (Exception ex)
        {
            Step("FeatureManager.FeatureRevolve2", false, FormatEx(ex));
        }
    }

    private void DoHole(dynamic model, CadOperation op, string units)
    {
        var plane = op.Str("plane", "Top");
        if (!SelectPlane(model, plane))
        {
            Step("hole", false, $"Piano non trovato: {plane}");
            return;
        }

        dynamic sketchMgr = model.SketchManager;
        sketchMgr.InsertSketch(true);
        TrySet(sketchMgr, "AddToDB", true);
        var cx = ToMeters(op.Num("cx"), units);
        var cy = ToMeters(op.Num("cy"), units);
        var r = ToMeters(op.Num("diameter", 6), units) / 2;
        try
        {
            sketchMgr.CreateCircleByRadius(cx, cy, 0, r);
        }
        catch
        {
            sketchMgr.CreateCircle(cx, cy, 0, cx + r, cy, 0);
        }

        sketchMgr.InsertSketch(false);

        var cutOp = new CadOperation
        {
            Id = op.Id,
            Type = "cut",
            Name = op.Name,
            Extra = new Dictionary<string, JsonElement>
            {
                ["throughAll"] = JsonSerializer.SerializeToElement(op.Flag("throughAll", true)),
                ["depth"] = JsonSerializer.SerializeToElement(op.Num("depth", 10)),
            },
        };
        DoExtrude(model, cutOp, units, cut: true);
    }

    private void DoFillet(dynamic model, CadOperation op, string units)
    {
        var radius = ToMeters(op.Num("radius", 1), units);
        if (op.Flag("allEdges", true))
        {
            SelectAllBodyEdges(model);
        }

        try
        {
            dynamic featMgr = model.FeatureManager;
            object? feat = null;
            try
            {
                feat = featMgr.FeatureFillet3(radius, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
            }
            catch
            {
                feat = featMgr.FeatureFillet(radius, false, 0, 0, 0, 0, 0, 0);
            }

            RememberFeature(op.Id, op.Name, feat);
            Step("FeatureManager.FeatureFillet", feat is not null && feat is not DBNull,
                $"R={op.Num("radius")} {units}");
        }
        catch (Exception ex)
        {
            Step("FeatureManager.FeatureFillet", false, FormatEx(ex));
        }
    }

    private void DoChamfer(dynamic model, CadOperation op, string units)
    {
        var dist = ToMeters(op.Num("distance", 1), units);
        if (op.Flag("allEdges", true))
        {
            SelectAllBodyEdges(model);
        }

        try
        {
            dynamic featMgr = model.FeatureManager;
            object feat = featMgr.InsertFeatureChamfer(1, 1, dist, 0.785398163, 0, 0, 0, 0);
            RememberFeature(op.Id, op.Name, feat);
            Step("FeatureManager.InsertFeatureChamfer", feat is not null, $"d={op.Num("distance")} {units}");
        }
        catch (Exception ex)
        {
            Step("FeatureManager.InsertFeatureChamfer", false, FormatEx(ex));
        }
    }

    private void DoShell(dynamic model, CadOperation op, string units)
    {
        var thickness = ToMeters(op.Num("thickness", 1), units);
        try
        {
            dynamic featMgr = model.FeatureManager;
            object feat = featMgr.InsertShell(thickness, true, false);
            RememberFeature(op.Id, op.Name, feat);
            Step("FeatureManager.InsertShell", feat is not null, $"t={op.Num("thickness")} {units}");
        }
        catch (Exception ex)
        {
            Step("FeatureManager.InsertShell", false, FormatEx(ex));
        }
    }

    private void DoPattern(dynamic model, CadOperation op, string units)
    {
        var featureId = op.Str("feature");
        if (_created.TryGetValue(featureId, out var fname))
        {
            SelectFeature(model, fname);
        }

        var kind = op.Str("kind", "linear");
        var count = (int)op.Num("count", 2);
        try
        {
            dynamic featMgr = model.FeatureManager;
            if (kind == "circular")
            {
                var angle = op.Num("angle", 360) * Math.PI / 180.0;
                object feat = featMgr.FeatureCircularPattern4(count, angle, false, "NULL", false, false, false);
                RememberFeature(op.Id, op.Name, feat);
                Step("FeatureManager.FeatureCircularPattern4", feat is not null, $"n={count}");
            }
            else
            {
                var spacing = ToMeters(op.Num("spacing", 20), units);
                object feat = featMgr.FeatureLinearPattern4(
                    count, spacing, 1, 0, false, false, "NULL", "NULL", false, false, false, false, false, false, true, true, false, false);
                RememberFeature(op.Id, op.Name, feat);
                Step("FeatureManager.FeatureLinearPattern4", feat is not null, $"n={count}");
            }
        }
        catch (Exception ex)
        {
            Step("pattern", false, FormatEx(ex));
        }
    }

    private void DoComponent(dynamic model, CadOperation op, string units)
    {
        var path = op.Str("path");
        var x = ToMeters(op.Num("x"), units);
        var y = ToMeters(op.Num("y"), units);
        var z = ToMeters(op.Num("z"), units);
        try
        {
            object comp = model.AddComponent5(path, 0, "", false, "", x, y, z);
            var ok = comp is not null && comp is not DBNull;
            if (ok)
            {
                RememberFeature(op.Id, op.Name ?? System.IO.Path.GetFileNameWithoutExtension(path), comp);
            }

            Step("AddComponent5", ok, path);
        }
        catch (Exception ex)
        {
            Step("AddComponent5", false, FormatEx(ex));
        }
    }

    private void DoMate(dynamic model, CadOperation op, string units)
    {
        var mateType = op.Str("mateType", "coincident").ToLowerInvariant() switch
        {
            "concentric" => SwMateConcentric,
            "parallel" => SwMateParallel,
            "perpendicular" => SwMatePerpendicular,
            "distance" => SwMateDistance,
            _ => SwMateCoincident,
        };
        var dist = ToMeters(op.Num("distance"), units);
        try
        {
            object mate = model.AddMate5(mateType, 0, false, dist, dist, dist, 0, 0, 0, 0, 0, false, false, 0, 0);
            var ok = mate is not null && mate is not DBNull;
            RememberFeature(op.Id, op.Name, mate);
            Step("AddMate5", ok, op.Str("mateType"));
        }
        catch (Exception ex)
        {
            Step("AddMate5", false, FormatEx(ex));
        }
    }

    private void DoDrawingView(dynamic model, CadOperation op)
    {
        var view = op.Str("view", "*Isometric");
        if (!view.StartsWith('*'))
        {
            view = "*" + view;
        }

        var x = op.Num("x", 0.15);
        var y = op.Num("y", 0.15);
        var modelPath = op.Str("model");
        try
        {
            object v;
            if (!string.IsNullOrEmpty(modelPath))
            {
                v = model.CreateDrawViewFromModelView3(modelPath, view, x, y, 0);
            }
            else
            {
                v = model.CreateDrawViewFromModelView2(view, x, y, 0);
            }

            var ok = v is not null && v is not DBNull;
            if (ok && op.Num("scale", 0) > 0)
            {
                try { ((dynamic)v).ScaleDecimal = op.Num("scale"); } catch { /* ignore */ }
            }

            Step("CreateDrawViewFromModelView", ok, view);
        }
        catch (Exception ex)
        {
            Step("CreateDrawViewFromModelView", false, FormatEx(ex));
        }
    }

    private void DoAnnotation(dynamic model, CadOperation op)
    {
        var text = op.Str("text");
        var x = op.Num("x", 0.01);
        var y = op.Num("y", 0.01);
        try
        {
            dynamic notes = model.InsertNote(text);
            try { notes.GetAnnotation().SetPosition2(x, y, 0); } catch { /* ignore */ }
            Step("InsertNote", notes is not null, text);
        }
        catch (Exception ex)
        {
            Step("InsertNote", false, FormatEx(ex));
        }
    }

    private bool SelectPlane(dynamic model, string plane)
    {
        var aliases = plane.ToLowerInvariant() switch
        {
            "front" or "frontale" => new[] { "Front Plane", "Piano frontale", "Piano Frontale", "Front" },
            "right" or "destro" => new[] { "Right Plane", "Piano destro", "Piano Destro", "Right" },
            _ => new[] { "Top Plane", "Piano superiore", "Piano Superiore", "Top" },
        };

        var feat = FeatureTreeReader.FindByTypeAndAlias(model, "RefPlane", aliases);
        if (feat is null)
        {
            var tree = FeatureTreeReader.Read((object)model);
            var all = tree.Where(f => f.TypeName == "RefPlane").ToList();
            var wanted = plane.ToLowerInvariant();
            var match = all.FirstOrDefault(f =>
                f.Name.Contains(wanted, StringComparison.OrdinalIgnoreCase) ||
                aliases.Any(a => f.Name.Equals(a, StringComparison.OrdinalIgnoreCase)));
            if (match is not null)
            {
                feat = model.FeatureByPositionReverse(match.Index);
            }
            else if (all.Count > 0)
            {
                var pick = wanted is "front" or "frontale"
                    ? all.ElementAtOrDefault(all.Count - 1)
                    : wanted is "right" or "destro"
                        ? all.ElementAtOrDefault(Math.Max(0, all.Count - 3))
                        : all.ElementAtOrDefault(Math.Max(0, all.Count - 2));
                if (pick is not null)
                {
                    feat = model.FeatureByPositionReverse(pick.Index);
                }
            }
        }

        if (feat is null)
        {
            return false;
        }

        try
        {
            return (bool)((dynamic)feat).Select2(false, 0);
        }
        catch
        {
            return false;
        }
    }

    private static bool SelectFeature(dynamic model, string name)
    {
        var feat = FeatureTreeReader.FindByName(model, name);
        if (feat is null)
        {
            return false;
        }

        try
        {
            return (bool)((dynamic)feat).Select2(false, 0);
        }
        catch
        {
            return false;
        }
    }

    private static void SelectAllBodyEdges(dynamic model)
    {
        try
        {
            dynamic part = model;
            object bodiesObj = part.GetBodies2(0, true);
            if (bodiesObj is not object[] bodies)
            {
                return;
            }

            var first = true;
            foreach (dynamic body in bodies)
            {
                object facesObj = body.GetFaces();
                if (facesObj is not object[] faces)
                {
                    continue;
                }

                foreach (dynamic face in faces)
                {
                    object edgesObj = face.GetEdges();
                    if (edgesObj is not object[] edges)
                    {
                        continue;
                    }

                    foreach (dynamic edge in edges)
                    {
                        edge.Select4(!first, null);
                        first = false;
                    }
                }
            }
        }
        catch
        {
            /* fillet may still run on current selection */
        }
    }

    private void RememberLatest(dynamic model, string id, string? name)
    {
        try
        {
            dynamic feat = model.FeatureByPositionReverse(0);
            RememberFeature(id, name, feat);
        }
        catch
        {
            if (!string.IsNullOrEmpty(id))
            {
                _created[id] = name ?? id;
            }
        }
    }

    private void RememberFeature(string id, string? name, object? feat)
    {
        if (feat is null || feat is DBNull)
        {
            return;
        }

        try
        {
            var featName = (string)((dynamic)feat).Name;
            if (!string.IsNullOrEmpty(id))
            {
                _created[id] = featName;
            }

            if (!string.IsNullOrEmpty(name))
            {
                _created[name] = featName;
            }
        }
        catch
        {
            if (!string.IsNullOrEmpty(id))
            {
                _created[id] = name ?? id;
            }
        }
    }

    private static double Len(JsonElement c, string name, string units)
    {
        if (!c.TryGetProperty(name, out var el))
        {
            return 0;
        }

        var v = el.ValueKind == JsonValueKind.Number ? el.GetDouble() : 0;
        return ToMeters(v, units);
    }

    private static double ToMeters(double value, string units)
    {
        return units.Equals("m", StringComparison.OrdinalIgnoreCase) ? value : value / 1000.0;
    }

    private void Step(string op, bool ok, string detail)
    {
        _steps.Add(new ExecStep { Op = op, Ok = ok, Detail = detail });
        var mark = ok ? "OK" : "FAIL";
        Console.WriteLine($"[{DateTime.Now:HH:mm:ss}] {mark} {op} — {detail}");
    }

    private static void TrySet(dynamic obj, string prop, object value)
    {
        try { ((object)obj).GetType(); obj.GetType(); } catch { /* dynamic */ }
        try
        {
            obj.GetType();
        }
        catch
        {
            /* ignore */
        }

        try
        {
            switch (prop)
            {
                case "Visible": obj.Visible = value; break;
                case "UserControl": obj.UserControl = value; break;
                case "UserControlBackground": obj.UserControlBackground = value; break;
                case "CommandInProgress": obj.CommandInProgress = value; break;
                case "AddToDB": obj.AddToDB = value; break;
            }
        }
        catch
        {
            /* property may not exist */
        }
    }

    private static void TryCall(dynamic obj, string method, params object[] args)
    {
        try
        {
            if (method == "SetUserPreferenceToggle" && args.Length == 2)
            {
                obj.SetUserPreferenceToggle(args[0], args[1]);
            }
        }
        catch
        {
            /* ignore */
        }
    }

    internal static string FormatEx(Exception ex)
    {
        if (ex is COMException com)
        {
            return $"COM 0x{com.ErrorCode:X8}: {com.Message}";
        }

        if (ex.InnerException is COMException inner)
        {
            return $"COM 0x{inner.ErrorCode:X8}: {inner.Message}";
        }

        return $"{ex.GetType().Name}: {ex.Message}";
    }
}
