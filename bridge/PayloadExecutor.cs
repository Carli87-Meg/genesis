using System.Globalization;
using System.Runtime.InteropServices;
using System.Text.Json;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

namespace SolidWorksBridge;

internal sealed partial class PayloadExecutor
{
    private readonly List<ExecStep> _steps = [];
    private readonly Dictionary<string, string> _created = new(StringComparer.OrdinalIgnoreCase);
    private List<CadOperation> _ops = [];
    private ISldWorks? _sw;
    private string? _sketchStillPath;
    private bool _quotedStillSaved;
    private double _sketchYOffsetM;

    public (List<ExecStep> Steps, List<FeatureInfo> Features, string? DocTitle, int? DocType, string? SavedPath, string? SnapshotPath) Execute(
        ISldWorks swApp,
        SolidWorksDocumentPayload payload)
    {
        _steps.Clear();
        _created.Clear();
        _ops = payload.Operations;
        _sw = swApp;
        _quotedStillSaved = false;
        _sketchStillIndex = 0;

        swApp.Visible = true;
        try { swApp.UserControl = true; } catch { /* ignore */ }
        try { swApp.CommandInProgress = false; } catch { /* mates fail if true */ }
        try { swApp.SetUserPreferenceToggle((int)swUserPreferenceToggle_e.swInputDimValOnCreate, false); }
        catch { /* ignore */ }

        SwPaths.EnsureProjectFolders();
        if (!string.IsNullOrWhiteSpace(payload.Document.OpenPath))
            payload.Document.OpenPath = SwPaths.Resolve(payload.Document.OpenPath);
        if (!string.IsNullOrWhiteSpace(payload.Document.SavePath))
            payload.Document.SavePath = SwPaths.Resolve(payload.Document.SavePath);
        if (!string.IsNullOrWhiteSpace(payload.Document.SnapshotPath))
            payload.Document.SnapshotPath = SwPaths.Resolve(payload.Document.SnapshotPath);
        _sketchStillPath = payload.Document.SnapshotPath;

        ModelDoc2? live = null;
        try
        {
            var model = OpenDocument(swApp, payload.Document);
            live = model;
            if (model is null)
            {
                Step("OpenDocument", false, "ActiveDoc è null dopo NewDocument/GetObject");
                return (_steps, [], null, null, null, null);
            }

            if (model.GetType() == (int)swDocumentTypes_e.swDocDRAWING &&
                string.IsNullOrWhiteSpace(payload.Document.OpenPath))
            {
                ApplySheetFormat(model, payload.Document.SheetFormat ?? "A3");
            }

            ApplyVariables(model, payload.Variables);

            foreach (var op in payload.Operations)
            {
                try
                {
                    RunOperation(model, op, payload.Units);
                }
                catch (Exception ex)
                {
                    Step(op.Type ?? "op", false, FormatEx(ex));
                }
            }

            ApplyConfigurations(model, payload.Configurations);

            var onlyPrefs = payload.Operations.Count > 0 && payload.Operations.TrueForAll(o =>
            {
                var t = (o.Type ?? "").Trim().ToLowerInvariant();
                return t is "filelocations" or "file_locations" or "setfilelocation" or "set_file_location";
            });
            if (!onlyPrefs)
            {
                ExitOpenSketchesAndRebuild(model);
                try
                {
                    model.ForceRebuild3(true);
                    Step("ForceRebuild3", true, "Ricostruzione completata");
                }
                catch (Exception ex)
                {
                    Step("ForceRebuild3", false, FormatEx(ex));
                }

                EnableVisibleDimensions(model);
                QuoteAllProfileFeatures(model);
                ExitOpenSketchesAndRebuild(model);
                ApplyMassUnitsAndPeso(model);
                Thread.Sleep(400);
            }

            var saved = SaveIfRequested(model, payload.Document);

            if (!onlyPrefs)
            {
                try { model.ViewZoomtofit2(); } catch { /* optional */ }
            }
            var snap = SnapshotIfRequested(model, payload.Document);

            string? title = null;
            int? docType = null;
            try { title = model.GetTitle(); } catch { /* ignore */ }
            try { docType = model.GetType(); } catch { /* ignore */ }

            var features = FeatureTreeReader.Read(model);
            Step("FeatureByPositionReverse", true, $"{features.Count} feature (GetTypeName2)");
            var dimCount = CountDisplayDimensions(model);
            var hadSketch = payload.Operations.Exists(o =>
            {
                var t = (o.Type ?? "").Trim().ToLowerInvariant();
                return t is "sketch" or "hole";
            });
            Step("DisplayDimensions", !hadSketch || dimCount > 0, $"{dimCount} quote visibili");
            SnapshotQuotedSketch(model, payload.Document);
            ExitOpenSketchesAndRebuild(model);
            CloseAfterExecute(swApp, model);
            return (_steps, features, title, docType, saved, snap);
        }
        finally
        {
            try { if (live is not null) TryExitOpenSketchesAndRebuild(live, forceRebuild: true); }
            catch { /* doc già chiuso */ }
            try
            {
                if (swApp.ActiveDoc is ModelDoc2 ad)
                    TryExitOpenSketchesAndRebuild(ad, forceRebuild: true);
            }
            catch { /* nessun doc attivo */ }
            try { swApp.CommandInProgress = false; } catch { /* ignore */ }
        }
    }

    private ModelDoc2? OpenDocument(ISldWorks swApp, DocumentSpec spec)
    {
        var kind = (spec.Type ?? "part").Trim().ToLowerInvariant();

        if (!string.IsNullOrWhiteSpace(spec.OpenPath))
        {
            var opened = OpenExisting(swApp, spec.OpenPath);
            if (opened is not null) return opened;
        }

        if (spec.AttachToActive)
        {
            if (swApp.ActiveDoc is ModelDoc2 active)
            {
                Step("AttachToActive", true, active.GetTitle());
                return active;
            }

            Step("AttachToActive", false, "Nessun documento attivo");
        }

        if (string.IsNullOrWhiteSpace(spec.OpenPath) && !string.IsNullOrWhiteSpace(spec.SavePath))
            CloseForeignDocAtPath(spec.SavePath, keep: null);

        return kind switch
        {
            "assembly" or "assieme" => NewAssembly(swApp, spec.Name),
            "drawing" or "tavola" or "disegno" => NewDrawing(swApp, spec.Name),
            _ => NewPart(swApp, spec.Name),
        };
    }

    private ModelDoc2? OpenExisting(ISldWorks swApp, string path)
    {
        var full = Path.GetFullPath(path);
        if (!File.Exists(full))
        {
            Step("OpenDoc6", false, $"File non trovato: {full}");
            return null;
        }

        try
        {
            if (swApp.GetOpenDocumentByName(full) is ModelDoc2 already)
            {
                var aErr = 0;
                try { swApp.ActivateDoc3(already.GetTitle(), false, 0, ref aErr); } catch { /* ignore */ }
                Step("ActivateDoc3", true, $"{Path.GetFileName(full)} già aperto");
                return already;
            }
        }
        catch
        {
            /* not open in this instance */
        }

        var dtype = full.EndsWith(".sldasm", StringComparison.OrdinalIgnoreCase)
            ? (int)swDocumentTypes_e.swDocASSEMBLY
            : full.EndsWith(".slddrw", StringComparison.OrdinalIgnoreCase)
                ? (int)swDocumentTypes_e.swDocDRAWING
                : (int)swDocumentTypes_e.swDocPART;
        var errors = 0;
        var warnings = 0;
        try
        {
            var doc = swApp.OpenDoc6(
                full,
                dtype,
                (int)swOpenDocOptions_e.swOpenDocOptions_Silent,
                "",
                ref errors,
                ref warnings) as ModelDoc2;
            Step("OpenDoc6", doc is not null, $"{Path.GetFileName(full)} errors={errors} warnings={warnings}");
            if (doc is not null)
            {
                var aErr = 0;
                try { swApp.ActivateDoc3(doc.GetTitle(), false, 0, ref aErr); } catch { /* ignore */ }
            }

            return doc;
        }
        catch (Exception ex)
        {
            Step("OpenDoc6", false, FormatEx(ex));
            return null;
        }
    }

    private ModelDoc2? NewPart(ISldWorks swApp, string name)
    {
        var template = TemplateLocator.Part();
        ModelDoc2? doc = null;
        try
        {
            doc = swApp.NewDocument(template, 0, 0.0, 0.0) as ModelDoc2;
            Step("NewDocument", doc is not null, $"template={template}");
        }
        catch (Exception ex)
        {
            Step("NewDocument", false, FormatEx(ex));
        }

        if (doc is null)
        {
            try
            {
                doc = swApp.NewPart() as ModelDoc2;
                Step("NewPart", doc is not null, "fallback NewPart()");
            }
            catch (Exception ex)
            {
                Step("NewPart", false, FormatEx(ex));
            }
        }

        RenameIfPossible(doc, name);
        return doc;
    }

    private ModelDoc2? NewAssembly(ISldWorks swApp, string name)
    {
        ModelDoc2? doc = null;
        try
        {
            doc = swApp.NewAssembly() as ModelDoc2;
            Step("NewAssembly", doc is not null, name);
        }
        catch (Exception ex)
        {
            Step("NewAssembly", false, FormatEx(ex));
        }

        if (doc is null)
        {
            var template = TemplateLocator.Assembly();
            try
            {
                doc = swApp.NewDocument(template, 0, 0.0, 0.0) as ModelDoc2;
                Step("NewDocument", doc is not null, $"assembly template={template}");
            }
            catch (Exception ex)
            {
                Step("NewDocument", false, FormatEx(ex));
            }
        }

        RenameIfPossible(doc, name);
        return doc;
    }

    private ModelDoc2? NewDrawing(ISldWorks swApp, string name)
    {
        ExitOpenSketchesOnAllDocuments(swApp);
        EnsureCartiglioFileLocations();
        ModelDoc2? doc = null;
        foreach (var template in TemplateLocator.ExistingDrawingTemplates())
        {
            try
            {
                doc = swApp.NewDrawing2(
                    (int)swDwgPaperSizes_e.swDwgPaperA3size,
                    template,
                    (int)swDwgTemplates_e.swDwgTemplateA3size,
                    0.42, 0.297) as ModelDoc2;
                if (doc is not null)
                {
                    Step("NewDrawing", true, $"template={template}");
                    break;
                }
            }
            catch
            {
                /* NewDocument fallback */
            }

            try
            {
                doc = swApp.NewDocument(template, 0, 0.42, 0.297) as ModelDoc2;
                Step("NewDocument", doc is not null, $"drawing via NewDocument {Path.GetFileName(template)}");
                if (doc is not null) break;
            }
            catch (Exception ex)
            {
                Step("NewDocument", false, FormatEx(ex));
            }
        }

        if (doc is null)
        {
            try
            {
                doc = swApp.NewDrawing2(
                    (int)swDwgPaperSizes_e.swDwgPaperA3size,
                    "",
                    (int)swDwgTemplates_e.swDwgTemplateA3size,
                    0.42, 0.297) as ModelDoc2;
                Step("NewDrawing", doc is not null, "fallback NewDrawing2(empty)");
            }
            catch (Exception ex)
            {
                Step("NewDrawing", false, FormatEx(ex));
            }
        }

        RenameIfPossible(doc, name);
        return doc;
    }

    private void ApplySheetFormat(ModelDoc2 model, string? hint)
    {
        if (model.GetType() != (int)swDocumentTypes_e.swDocDRAWING)
        {
            Step("SetupSheet5", false, "non è una tavola");
            return;
        }

        EnsureCartiglioFileLocations();
        var path = TemplateLocator.SheetFormat(hint);
        if (string.IsNullOrWhiteSpace(path) || !File.Exists(path))
        {
            Step("SetupSheet5", false, $"Cartiglio_CM non trovato (hint={hint})");
            return;
        }

        if (path.Contains(@"\ProgramData\", StringComparison.OrdinalIgnoreCase))
        {
            Step("SetupSheet5", false, $"rifiutato path ProgramData: {path}");
            return;
        }

        var drawing = (IDrawingDoc)model;
        var name = "Foglio1";
        Sheet? sheet = null;
        try
        {
            sheet = drawing.GetCurrentSheet() as Sheet;
            if (sheet is not null) name = sheet.GetName();
        }
        catch { /* Foglio1 */ }

        var a2 = path.Contains("A2", StringComparison.OrdinalIgnoreCase);
        var w = a2 ? 0.594 : 0.420;
        var h = a2 ? 0.420 : 0.297;
        var paper = a2
            ? (int)swDwgPaperSizes_e.swDwgPaperA2size
            : (int)swDwgPaperSizes_e.swDwgPaperA3size;
        var templateCustom = (int)swDwgTemplates_e.swDwgTemplateCustom;

        var ok = false;
        try
        {
            ok = drawing.SetupSheet5(name, paper, templateCustom, 1, 1, true, path, w, h, "", false);
        }
        catch (Exception ex)
        {
            Step("SetupSheet5", false, FormatEx(ex));
        }

        if (!ok)
        {
            try
            {
                ok = drawing.SetupSheet5(
                    name,
                    (int)swDwgPaperSizes_e.swDwgPapersUserDefined,
                    templateCustom, 1, 1, true, path, w, h, "", false);
            }
            catch (Exception ex)
            {
                Step("SetupSheet5", false, "userDefined: " + FormatEx(ex));
            }
        }

        if (!ok)
        {
            try
            {
                ok = drawing.SetupSheet4(name, paper, templateCustom, 1, 1, true, path, w, h, "");
            }
            catch (Exception ex)
            {
                Step("SetupSheet4", false, FormatEx(ex));
            }
        }

        try { sheet ??= drawing.GetCurrentSheet() as Sheet; } catch { /* ignore */ }
        if (sheet is not null)
        {
            try { sheet.SheetFormatVisible = true; } catch { /* ignore */ }
            try { sheet.SetTemplateName(path); } catch { /* ignore */ }
            try { sheet.SetSheetFormatName(path); } catch { /* ignore */ }
            try { sheet.ReloadTemplate(false); } catch { /* ignore */ }
        }

        try { model.ForceRebuild3(false); } catch { /* ignore */ }
        try { model.EditRebuild3(); } catch { /* ignore */ }
        try { model.GraphicsRedraw2(); } catch { /* ignore */ }

        string applied = "";
        try { applied = sheet?.GetTemplateName() ?? ""; } catch { /* ignore */ }
        if (string.IsNullOrWhiteSpace(applied))
        {
            try { applied = sheet?.GetSheetFormatName() ?? ""; } catch { /* ignore */ }
        }

        var isCm = IsCartiglioCmPath(applied) || (ok && IsCartiglioCmPath(path));
        if (IsDefaultSolidWorksSheet(applied))
            isCm = false;
        Step("SetupSheet5", isCm,
            $"{Path.GetFileName(path)} sheet={name} applied={applied} {w * 1000:0}x{h * 1000:0} mm");
    }

    private static bool IsCartiglioCmPath(string? p)
    {
        if (string.IsNullOrWhiteSpace(p)) return false;
        return p.Contains("Cartiglio_CM", StringComparison.OrdinalIgnoreCase)
               || p.Contains("PARTE_A3_CM", StringComparison.OrdinalIgnoreCase)
               || p.Contains("PARTE_A2_CM", StringComparison.OrdinalIgnoreCase);
    }

    private static bool IsDefaultSolidWorksSheet(string? p)
    {
        if (string.IsNullOrWhiteSpace(p)) return false;
        return p.Contains(@"\lang\italian\sheetformat", StringComparison.OrdinalIgnoreCase)
               || p.Contains(@"\lang\english\sheetformat", StringComparison.OrdinalIgnoreCase);
    }

    private static void RenameIfPossible(ModelDoc2? doc, string name)
    {
        if (doc is null || string.IsNullOrWhiteSpace(name))
        {
            return;
        }

        try { doc.SetTitle2(name); } catch { /* requires save on some versions */ }
    }

    private void ApplyVariables(ModelDoc2 model, List<CadVariable> variables)
    {
        if (variables.Count == 0) return;
        try
        {
            var eq = (IEquationMgr)model.GetEquationMgr();
            foreach (var v in variables)
            {
                if (string.IsNullOrWhiteSpace(v.Name)) continue;
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

    private void ApplyConfigurations(ModelDoc2 model, List<CadConfiguration> configs)
    {
        foreach (var cfg in configs)
        {
            if (string.IsNullOrWhiteSpace(cfg.Name)) continue;
            try
            {
                var added = model.AddConfiguration3(cfg.Name, "", "", (int)swConfigurationOptions2_e.swConfigOption_DontActivate);
                Step("AddConfiguration3", added is not null, cfg.Name);
            }
            catch (Exception ex)
            {
                try
                {
                    model.AddConfiguration3(cfg.Name, "", "", 0);
                    Step("AddConfiguration3", true, cfg.Name);
                }
                catch
                {
                    Step("AddConfiguration2", false, FormatEx(ex));
                }
            }
        }
    }

    private void RunOperation(ModelDoc2 model, CadOperation op, string units)
    {
        switch ((op.Type ?? "").Trim().ToLowerInvariant())
        {
            case "sketch": DoSketch(model, op, units); break;
            case "extrude": DoExtrude(model, op, units, cut: false); break;
            case "cut": DoExtrude(model, op, units, cut: true); break;
            case "revolve": DoRevolve(model, op); break;
            case "sweep": DoSweep(model, op); break;
            case "hole": DoHole(model, op, units); break;
            case "fillet": DoFillet(model, op, units); break;
            case "chamfer": DoChamfer(model, op, units); break;
            case "shell": DoShell(model, op, units); break;
            case "pattern": DoPattern(model, op, units); break;
            case "component": DoComponent(model, op, units); break;
            case "mate": DoMate(model, op, units); break;
            case "clearmates":
            case "clear_mates": DoClearMates(model); break;
            case "inspect": DoInspect(model); break;
            case "verify": DoVerifyLayout(model, op, units); break;
            case "filelocations":
            case "file_locations": DoFileLocations(); break;
            case "setfilelocation":
            case "set_file_location": DoSetFileLocation(op); break;
            case "drawingview":
            case "drawing_view": DoDrawingView(model, op); break;
            case "standardviews":
            case "standard_views": DoStandardViews(model, op); break;
            case "modeldimensions":
            case "model_dimensions": DoModelDimensions(model, op); break;
            case "annotation": DoAnnotation(model, op); break;
            case "sheetformat":
            case "sheet_format":
            case "setupsheet":
            case "setup_sheet":
                ApplySheetFormat(model, op.Str("format", op.Str("path", "A3")));
                break;
            case "quoteSketches":
            case "quote_sketches":
            case "quotesketches":
                QuoteAllProfileFeatures(model);
                break;
        }
    }

    private void DoSketch(ModelDoc2 model, CadOperation op, string units)
    {
        var plane = op.Str("plane", "Top");
        if (!SelectPlane(model, plane))
        {
            Step("sketch", false, $"Piano non trovato: {plane}");
            return;
        }

        var sketchMgr = (ISketchManager)model.SketchManager;
        sketchMgr.InsertSketch(true);
        _sketchYOffsetM = 0;
        try
        {
            try { sketchMgr.AddToDB = false; } catch { /* ignore */ }
            try { sketchMgr.DisplayWhenAdded = true; } catch { /* ignore */ }
            EnableVisibleDimensions(model);

            var contours = op.Field("contours");
            if (WillRevolveCut(op.Id) && plane is "Front" or "front")
            {
                var bodyTop = BodyYMaxMm(model);
                var sketchTop = MaxContourYMm(contours);
                if (!double.IsNaN(bodyTop) && !double.IsNaN(sketchTop))
                {
                    _sketchYOffsetM = (bodyTop - sketchTop) / 1000.0;
                    if (Math.Abs(_sketchYOffsetM) > 1e-6)
                        Step("cskAlign", true, $"dy={_sketchYOffsetM * 1000:0.02} mm bodyYmax={bodyTop:0.02} sketchYmax={sketchTop:0.02}");
                }
            }
            var n = 0;
            var dims = 0;
            if (contours is { ValueKind: JsonValueKind.Array })
            {
                foreach (var c in contours.Value.EnumerateArray())
                {
                    if (DrawContour(model, sketchMgr, c, units, ref dims)) n++;
                }
            }

            // FullyDefineSketch (Equal/Concentric/Tangent) snaps flange-hole circles
            // onto existing revolve edges and changes Ø (Ø6.5 → Ø16.5). Skip it when
            // every contour is a circle off the origin; still add diameter/offset dims.
            if (IsOffCenterCircleSketch(contours))
            {
                try { sketchMgr.AutoInference = false; } catch { /* ignore */ }
                EnableVisibleDimensions(model);
                dims = Math.Max(dims, DimensionAllSegments(model) + DimensionCentersFromOrigin(model));
                RevealAllDisplayDimensions(model);
                Step("QuoteActiveSketch", true, "skip FullyDefineSketch (fori decentrati)");
            }
            else
            {
                dims = Math.Max(dims, QuoteActiveSketch(model, sketchMgr));
            }
            CaptureQuotedSketch(model);
            RememberLatest(model, op.Id, op.Name);
            Step("SketchManager", true, $"{n} contorni su {plane}, {dims} quote");
        }
        finally
        {
            _sketchYOffsetM = 0;
            ExitOpenSketchesAndRebuild(model, forceRebuild: false);
        }
    }

    private bool WillRevolveCut(string sketchId)
    {
        if (string.IsNullOrEmpty(sketchId)) return false;
        foreach (var op in _ops)
        {
            if (!string.Equals(op.Type, "revolve", StringComparison.OrdinalIgnoreCase)) continue;
            if (!string.Equals(op.Str("sketch"), sketchId, StringComparison.OrdinalIgnoreCase)) continue;
            if (op.Flag("cut")) return true;
        }
        return false;
    }

    private static double BodyYMaxMm(ModelDoc2 model)
    {
        try
        {
            if (model is not IPartDoc part) return double.NaN;
            var bodies = AsArray(part.GetBodies2((int)swBodyType_e.swSolidBody, true));
            if (bodies is null) return double.NaN;
            var yMax = double.NaN;
            foreach (var bObj in bodies)
            {
                if (bObj is not Body2 body) continue;
                var box = AsDoubles(body.GetBodyBox());
                if (box is not { Length: >= 6 }) continue;
                var y = Math.Max(box[1], box[4]) * 1000.0;
                if (double.IsNaN(yMax) || y > yMax) yMax = y;
            }
            return yMax;
        }
        catch
        {
            return double.NaN;
        }
    }

    private static double MaxContourYMm(JsonElement? contours)
    {
        if (contours is not { ValueKind: JsonValueKind.Array }) return double.NaN;
        var max = double.NaN;
        foreach (var c in contours.Value.EnumerateArray())
        {
            foreach (var key in new[] { "y1", "y2", "y3", "cy" })
            {
                if (!c.TryGetProperty(key, out var el) || el.ValueKind != JsonValueKind.Number) continue;
                var y = el.GetDouble();
                if (double.IsNaN(max) || y > max) max = y;
            }
        }
        return max;
    }

    private static bool IsOffCenterCircleSketch(JsonElement? contours)
    {
        if (contours is not { ValueKind: JsonValueKind.Array } arr || arr.GetArrayLength() == 0)
            return false;
        var anyOff = false;
        foreach (var c in arr.EnumerateArray())
        {
            var kind = c.TryGetProperty("kind", out var k) ? k.GetString() ?? "" : "";
            if (!kind.Equals("circle", StringComparison.OrdinalIgnoreCase))
                return false;
            var cx = c.TryGetProperty("cx", out var x) && x.ValueKind == JsonValueKind.Number ? x.GetDouble() : 0;
            var cy = c.TryGetProperty("cy", out var y) && y.ValueKind == JsonValueKind.Number ? y.GetDouble() : 0;
            if (Math.Abs(cx) > 0.5 || Math.Abs(cy) > 0.5) anyOff = true;
        }
        return anyOff;
    }

    private bool DrawContour(ModelDoc2 model, ISketchManager sketchMgr, JsonElement c, string units, ref int dims)
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
                    sketchMgr.CreateCornerRectangle(cx - w / 2, cy - h / 2, 0, cx + w / 2, cy + h / 2, 0);
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
                    sketchMgr.CreateCircleByRadius(cx, cy, 0, r);
                    return true;
                }
                case "line":
                {
                    var line = (ISketchSegment)sketchMgr.CreateLine(
                        Len(c, "x1", units), Len(c, "y1", units) + _sketchYOffsetM, 0,
                        Len(c, "x2", units), Len(c, "y2", units) + _sketchYOffsetM, 0);
                    if (c.TryGetProperty("construction", out var cons) && cons.ValueKind == JsonValueKind.True)
                    {
                        try { line.ConstructionGeometry = true; } catch { /* ignore */ }
                    }
                    return true;
                }
                case "arc":
                case "arco":
                {
                    sketchMgr.Create3PointArc(
                        Len(c, "x1", units), Len(c, "y1", units) + _sketchYOffsetM, 0,
                        Len(c, "x2", units), Len(c, "y2", units) + _sketchYOffsetM, 0,
                        Len(c, "x3", units), Len(c, "y3", units) + _sketchYOffsetM, 0);
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

    private void DoExtrude(ModelDoc2 model, CadOperation op, string units, bool cut)
    {
        var sketchId = op.Str("sketch");
        if (!string.IsNullOrEmpty(sketchId) && _created.TryGetValue(sketchId, out var sketchName))
        {
            SelectFeature(model, sketchName);
        }

        var featMgr = (IFeatureManager)model.FeatureManager;
        var depth = ToMeters(op.Num("depth", 10), units);
        var flip = op.Flag("flip");
        var merge = op.Flag("merge", true);
        var throughAll = op.Flag("throughAll");
        var t1 = throughAll
            ? (int)swEndConditions_e.swEndCondThroughAll
            : (int)swEndConditions_e.swEndCondBlind;

        Feature? feat;
        try
        {
            if (cut)
            {
                feat = featMgr.FeatureCut3(
                    true, flip, true, t1, (int)swEndConditions_e.swEndCondBlind, depth, 0,
                    false, false, false, false, 0.0, 0.0,
                    false, false, false, false,
                    false, true, true, true, true, false,
                    (int)swStartConditions_e.swStartSketchPlane, 0, false);
                if (feat is null)
                {
                    feat = featMgr.FeatureCut3(
                        true, flip, false, t1, (int)swEndConditions_e.swEndCondBlind, depth, 0,
                        false, false, false, false, 0.0, 0.0,
                        false, false, false, false,
                        false, true, true, true, true, false,
                        (int)swStartConditions_e.swStartSketchPlane, 0, false);
                }
                if (feat is null)
                {
                    feat = featMgr.FeatureCut3(
                        true, !flip, true, t1, (int)swEndConditions_e.swEndCondBlind, depth, 0,
                        false, false, false, false, 0.0, 0.0,
                        false, false, false, false,
                        false, true, true, true, true, false,
                        (int)swStartConditions_e.swStartSketchPlane, 0, false);
                }
                if (feat is null)
                {
                    feat = featMgr.FeatureCut3(
                        true, !flip, false, t1, (int)swEndConditions_e.swEndCondBlind, depth, 0,
                        false, false, false, false, 0.0, 0.0,
                        false, false, false, false,
                        false, true, true, true, true, false,
                        (int)swStartConditions_e.swStartSketchPlane, 0, false);
                }
                if (feat is null)
                {
                    feat = featMgr.FeatureCut4(
                        true, flip, true, t1, (int)swEndConditions_e.swEndCondBlind, Math.Max(depth, 0.01), 0,
                        false, false, false, false, 0.0, 0.0,
                        false, false, false, false,
                        false, true, true, true, true, false,
                        (int)swStartConditions_e.swStartSketchPlane, 0, false, false);
                }
            }
            else
            {
                feat = featMgr.FeatureExtrusion3(
                    true, flip, true, t1, (int)swEndConditions_e.swEndCondBlind, depth, 0,
                    false, false, false, false, 0.0, 0.0,
                    false, false, false, false,
                    merge, true, true,
                    (int)swStartConditions_e.swStartSketchPlane, 0.0, false);
                if (feat is null)
                {
                    feat = featMgr.FeatureExtrusion3(
                        true, false, flip, t1, (int)swEndConditions_e.swEndCondBlind, depth, 0,
                        false, false, false, false, 0.0, 0.0,
                        false, false, false, false,
                        merge, true, true,
                        (int)swStartConditions_e.swStartSketchPlane, 0.0, false);
                }
                if (feat is null)
                {
                    feat = featMgr.FeatureExtrusion3(
                        true, false, false, t1, (int)swEndConditions_e.swEndCondBlind, depth, 0,
                        false, false, false, false, 0.0, 0.0,
                        false, false, false, false,
                        merge, true, true,
                        (int)swStartConditions_e.swStartSketchPlane, 0.0, false);
                }
                if (feat is null)
                {
                    feat = featMgr.FeatureExtrusion2(
                        true, false, false, t1, (int)swEndConditions_e.swEndCondBlind, depth, 0,
                        false, false, false, false, 0.0, 0.0,
                        false, false, false, false,
                        merge, true, true,
                        (int)swStartConditions_e.swStartSketchPlane, 0.0, false) as Feature;
                }
            }
        }
        catch (Exception ex)
        {
            Step(cut ? "FeatureManager.FeatureCut" : "FeatureManager.FeatureExtrusion", false, FormatEx(ex));
            return;
        }

        if (feat is not null) RememberFeature(op.Id, op.Name, feat);
        Step(cut ? "FeatureManager.FeatureCut" : "FeatureManager.FeatureExtrusion", feat is not null,
            throughAll ? "throughAll" : $"depth={op.Num("depth")} {units}");
    }

    private void DoRevolve(ModelDoc2 model, CadOperation op)
    {
        var sketchId = op.Str("sketch");
        if (!string.IsNullOrEmpty(sketchId) && _created.TryGetValue(sketchId, out var sketchName))
        {
            SelectFeature(model, sketchName);
        }

        var angle = op.Num("angle", 360) * Math.PI / 180.0;
        var isCut = op.Flag("cut");
        var featMgr = (IFeatureManager)model.FeatureManager;
        Feature? feat = null;
        try
        {
            if (isCut)
            {
                feat = featMgr.FeatureRevolveCut2(
                    angle, false, 0, 0, 0, true, true, false, false, false) as Feature;
                if (feat is null)
                {
                    feat = featMgr.FeatureRevolveCut2(
                        angle, true, 0, 0, 0, true, true, false, false, false) as Feature;
                }
                if (feat is null)
                {
                    feat = featMgr.FeatureRevolveCut(angle, false, 0, 0, 0, true, true) as Feature;
                }
                if (feat is null)
                {
                    feat = featMgr.FeatureRevolveCut(angle, true, 0, 0, 0, true, true) as Feature;
                }
                if (feat is null)
                {
                    feat = featMgr.FeatureRevolve2(
                        true, true, false, true, false, false, 0, 0,
                        angle, 0, false, false, 0, 0,
                        0, 0, 0, false, true, true);
                }
                if (feat is null)
                {
                    feat = featMgr.FeatureRevolve2(
                        true, true, false, true, true, false, 0, 0,
                        angle, 0, false, false, 0, 0,
                        0, 0, 0, false, true, true);
                }
            }
            else
            {
                feat = featMgr.FeatureRevolve2(
                    true, true, false, false, false, false, 0, 0,
                    angle, 0, false, false, 0, 0,
                    0, 0, 0, true, true, true);
            }

            var nSel = 0;
            try { nSel = ((ISelectionMgr)model.SelectionManager).GetSelectedObjectCount2(-1); } catch { /* ignore */ }
            if (feat is not null) RememberFeature(op.Id, op.Name, feat);
            Step(
                isCut ? "FeatureManager.FeatureRevolveCut" : "FeatureManager.FeatureRevolve2",
                feat is not null,
                $"angle={op.Num("angle", 360)}° cut={isCut} sel={nSel} sketch={sketchId}");
        }
        catch (Exception ex)
        {
            Step(isCut ? "FeatureManager.FeatureRevolveCut" : "FeatureManager.FeatureRevolve2", false, FormatEx(ex));
        }
    }

    private void DoSweep(ModelDoc2 model, CadOperation op)
    {
        var profileId = op.Str("profile", op.Str("sketch"));
        var pathId = op.Str("path", op.Str("guide"));
        if (string.IsNullOrWhiteSpace(profileId) || string.IsNullOrWhiteSpace(pathId))
        {
            Step("sweep", false, "servono profile e path (id schizzo)");
            return;
        }

        if (!_created.TryGetValue(profileId, out var profileName) || string.IsNullOrWhiteSpace(profileName))
            profileName = profileId;
        if (!_created.TryGetValue(pathId, out var pathName) || string.IsNullOrWhiteSpace(pathName))
            pathName = pathId;

        try { model.ClearSelection2(true); } catch { /* ignore */ }
        if (!SelectFeatureMark(model, profileName, append: false, mark: 1))
        {
            Step("sweep", false, $"profilo non selezionato: {profileName}");
            return;
        }
        if (!SelectFeatureMark(model, pathName, append: true, mark: 4))
        {
            Step("sweep", false, $"percorso non selezionato: {pathName}");
            return;
        }

        var merge = op.Flag("merge", true);
        Feature? feat = null;
        var featMgr = (IFeatureManager)model.FeatureManager;
        try
        {
            feat = featMgr.InsertProtrusionSwept4(
                false, true, 0, false, false, 0, 0,
                false, 0, 0, 0, 0,
                merge, true, true,
                0, true, false, 0, 0);
        }
        catch (Exception ex)
        {
            Step("InsertProtrusionSwept4", false, FormatEx(ex));
        }

        if (feat is null)
        {
            try
            {
                feat = featMgr.InsertProtrusionSwept3(
                    false, true, 0, false, false, 0, 0,
                    false, 0, 0, 0, 0,
                    merge, true, true, 0, true);
            }
            catch (Exception ex)
            {
                Step("InsertProtrusionSwept3", false, FormatEx(ex));
            }
        }

        if (feat is not null) RememberFeature(op.Id, op.Name, feat);
        Step("FeatureManager.InsertProtrusionSwept", feat is not null, $"profile={profileName} path={pathName}");
    }

    private static bool SelectFeatureMark(ModelDoc2 model, string name, bool append, int mark)
    {
        var feat = FeatureTreeReader.FindByName(model, name);
        if (feat is null) return false;
        try
        {
            return feat.Select2(append, mark);
        }
        catch
        {
            return feat.Select2(append, 0);
        }
    }

    private void DoHole(ModelDoc2 model, CadOperation op, string units)
    {
        var plane = op.Str("plane", "Top");
        if (!SelectPlane(model, plane))
        {
            Step("hole", false, $"Piano non trovato: {plane}");
            return;
        }

        var sketchMgr = (ISketchManager)model.SketchManager;
        sketchMgr.InsertSketch(true);
        try
        {
            try { sketchMgr.AddToDB = false; } catch { /* ignore */ }
            try { sketchMgr.DisplayWhenAdded = true; } catch { /* ignore */ }
            EnableVisibleDimensions(model);
            var cx = ToMeters(op.Num("cx"), units);
            var cy = ToMeters(op.Num("cy"), units);
            var r = ToMeters(op.Num("diameter", 6), units) / 2;
            sketchMgr.CreateCircleByRadius(cx, cy, 0, r);
            QuoteActiveSketch(model, sketchMgr);
            CaptureQuotedSketch(model);
        }
        finally
        {
            ExitOpenSketchesAndRebuild(model, forceRebuild: false);
        }

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

    private void DoFillet(ModelDoc2 model, CadOperation op, string units)
    {
        var radiusMm = op.Num("radius", 1);
        var radius = ToMeters(radiusMm, units);
        var nSel = 0;
        if (op.Flag("allEdges", true))
        {
            nSel = SelectThicknessEdges(model);
            if (nSel == 0)
            {
                SelectAllBodyEdges(model);
                nSel = -1;
            }
        }

        Step("selectEdges", true, nSel >= 0 ? $"spessore n={nSel}" : "tutti gli spigoli");

        var opts =
            (int)swFeatureFilletOptions_e.swFeatureFilletPropagate |
            (int)swFeatureFilletOptions_e.swFeatureFilletUniformRadius;
        var featMgr = (IFeatureManager)model.FeatureManager;
        Feature? feat = TryFeatureFillet(featMgr, opts, radius);
        if (feat is null && nSel > 0)
        {
            SelectAllBodyEdges(model);
            feat = TryFeatureFillet(featMgr, opts, radius);
            if (feat is not null) nSel = -1;
        }

        if (feat is not null) RememberFeature(op.Id, op.Name, feat);
        Step("FeatureManager.FeatureFillet", feat is not null, $"R={radiusMm} {units} edges={nSel}");
    }

    private static Feature? TryFeatureFillet(IFeatureManager featMgr, int opts, double radius)
    {
        try
        {
            if (featMgr.FeatureFillet3(
                    opts, radius, 0, 0, 0, 0, 0,
                    null, null, null, null, null, null, null) is Feature a)
                return a;
        }
        catch { /* FeatureFillet */ }

        try
        {
            if (featMgr.FeatureFillet(opts, radius, 0, 0, null, null, null) is Feature b)
                return b;
        }
        catch { /* FeatureFillet2 */ }

        try
        {
            if (featMgr.FeatureFillet2(
                    opts, radius, 0, 0, 0, 0,
                    null, null, null, null, null) is Feature c)
                return c;
        }
        catch { /* none */ }

        return null;
    }

    private void DoChamfer(ModelDoc2 model, CadOperation op, string units)
    {
        var dist = ToMeters(op.Num("distance", 1), units);
        if (op.Flag("allEdges", true)) SelectAllBodyEdges(model);
        try
        {
            var featMgr = (IFeatureManager)model.FeatureManager;
            var feat = featMgr.InsertFeatureChamfer(1, 1, dist, 0.785398163, 0, 0, 0, 0) as Feature;
            if (feat is not null) RememberFeature(op.Id, op.Name, feat);
            Step("FeatureManager.InsertFeatureChamfer", feat is not null, $"d={op.Num("distance")} {units}");
        }
        catch (Exception ex)
        {
            Step("FeatureManager.InsertFeatureChamfer", false, FormatEx(ex));
        }
    }

    private void DoShell(ModelDoc2 model, CadOperation op, string units)
    {
        Step("FeatureManager.InsertShell", false,
            $"InsertShell non esposto in questa interop (t={op.Num("thickness")} {units})");
    }

    private void DoPattern(ModelDoc2 model, CadOperation op, string units)
    {
        var featureId = op.Str("feature");
        if (_created.TryGetValue(featureId, out var fname)) SelectFeature(model, fname);
        var kind = op.Str("kind", "linear");
        var count = (int)op.Num("count", 2);
        try
        {
            var featMgr = (IFeatureManager)model.FeatureManager;
            Feature? feat;
            if (kind == "circular")
            {
                var angle = op.Num("angle", 360) * Math.PI / 180.0;
                feat = featMgr.FeatureCircularPattern4(count, angle, false, "NULL", false, false, false) as Feature;
                Step("FeatureManager.FeatureCircularPattern4", feat is not null, $"n={count}");
            }
            else
            {
                var spacing = ToMeters(op.Num("spacing", 20), units);
                feat = featMgr.FeatureLinearPattern4(
                    count, spacing, 1, 0, false, false, "NULL", "NULL",
                    false, false, false, false, false, false, true, true, false, false, 0, 0);
                Step("FeatureManager.FeatureLinearPattern4", feat is not null, $"n={count}");
            }
            if (feat is not null) RememberFeature(op.Id, op.Name, feat);
        }
        catch (Exception ex)
        {
            Step("pattern", false, FormatEx(ex));
        }
    }

    private void DoComponent(ModelDoc2 model, CadOperation op, string units)
    {
        if (model is not IAssemblyDoc assy)
        {
            Step("AddComponent5", false, "Il documento non è un assieme");
            return;
        }

        var path = SwPaths.Resolve(op.Str("path"));
        if (string.IsNullOrWhiteSpace(path))
        {
            Step("AddComponent5", false, "path mancante");
            return;
        }

        var full = Path.GetFullPath(path);
        if (!File.Exists(full))
        {
            Step("AddComponent5", false, $"File non trovato: {path}");
            return;
        }

        if (_sw is not null)
        {
            var oErr = 0;
            var oWarn = 0;
            try
            {
                var opened = _sw.OpenDoc6(
                    full,
                    (int)swDocumentTypes_e.swDocPART,
                    (int)swOpenDocOptions_e.swOpenDocOptions_Silent,
                    "",
                    ref oErr,
                    ref oWarn);
                Step("OpenDoc6", opened is not null, $"{Path.GetFileName(full)} errors={oErr}");
            }
            catch (Exception ex)
            {
                Step("OpenDoc6", false, FormatEx(ex));
            }

            try
            {
                var aErr = 0;
                _sw.ActivateDoc3(model.GetTitle(), false, 0, ref aErr);
            }
            catch
            {
                try { _sw.ActivateDoc(model.GetTitle()); } catch { /* ignore */ }
            }
        }

        var x = ToMeters(op.Num("x"), units);
        var y = ToMeters(op.Num("y"), units);
        var z = ToMeters(op.Num("z"), units);
        try
        {
            object? compObj = assy.AddComponent5(
                full,
                (int)swAddComponentConfigOptions_e.swAddComponentConfigOptions_CurrentSelectedConfig,
                "",
                false,
                "",
                x, y, z);
            if (compObj is not Component2)
            {
                try { compObj = assy.AddComponent(full, x, y, z); } catch { /* next */ }
            }
            if (compObj is not Component2 comp)
            {
                Step("AddComponent5", false, full);
                return;
            }

            var inst = comp.Name2;
            if (!string.IsNullOrEmpty(op.Id)) _created[op.Id] = inst;
            if (!string.IsNullOrEmpty(op.Name)) _created[op.Name] = inst;
            _created[Path.GetFileNameWithoutExtension(full)] = inst;
            _created[Path.GetFileName(full)] = inst;
            _created[full] = inst;
            var given = op.Str("path");
            if (!string.IsNullOrWhiteSpace(given))
            {
                _created[given] = inst;
                _created[given.Replace('\\', '/')] = inst;
            }

            if (op.Flag("fix"))
            {
                try
                {
                    comp.Select4(false, null, false);
                    assy.FixComponent();
                    Step("FixComponent", true, inst);
                }
                catch (Exception ex)
                {
                    Step("FixComponent", false, FormatEx(ex));
                }
            }

            Step("AddComponent5", true, inst);

            try
            {
                try
                {
                    if (_sw?.GetOpenDocumentByName(full) is ModelDoc2 partDoc)
                        ExitOpenSketchesAndRebuild(partDoc);
                }
                catch { /* ignore */ }
                _sw?.CloseDoc(Path.GetFileName(full));
                var aErr = 0;
                _sw?.ActivateDoc3(model.GetTitle(), false, 0, ref aErr);
            }
            catch
            {
                /* leave part window if CloseDoc fails */
            }
        }
        catch (Exception ex)
        {
            Step("AddComponent5", false, FormatEx(ex));
        }
    }

    private void DoMate(ModelDoc2 model, CadOperation op, string units)
    {
        if (model is not IAssemblyDoc assy)
        {
            Step("AddMate5", false, "Il documento non è un assieme");
            return;
        }

        try { _sw!.CommandInProgress = false; } catch { /* ignore */ }

        var c1 = op.Str("component1");
        var c2 = op.Str("component2");
        var e1 = op.Str("entity1", op.Str("plane1", "Front"));
        var e2 = op.Str("entity2", op.Str("plane2", "Front"));
        var kind = op.Str("mateType", op.Str("subtype", op.Str("kind", "coincident"))).ToLowerInvariant();
        if (kind is "linear" or "circular" or "sketch") kind = "coincident";
        model.ClearSelection2(true);

        var selData = CreateMark1(model);
        var targetR = ToMeters(op.Num("diameter", op.Num("diameter1", 0)), units) / 2.0;
        double? pickX = op.Has("holeX") ? ToMeters(op.Num("holeX"), units) : null;
        double? pickY = op.Has("holeY") ? ToMeters(op.Num("holeY"), units) : null;
        double? pickZ = op.Has("holeZ") ? ToMeters(op.Num("holeZ"), units) : null;
        var sel1 = SelectMateEntity(assy, c1, e1, append: false, selData, kind, targetR, pickX, pickY, pickZ);
        var sel2 = SelectMateEntity(assy, c2, e2, append: true, selData, kind, targetR, pickX, pickY, pickZ);
        if (!sel1 || !sel2)
        {
            Step("AddMate5", false, $"Selezione fallita {c1}/{e1} ({sel1}) + {c2}/{e2} ({sel2})");
            return;
        }

        var mateType = kind switch
        {
            "concentric" => (int)swMateType_e.swMateCONCENTRIC,
            "parallel" => (int)swMateType_e.swMatePARALLEL,
            "perpendicular" => (int)swMateType_e.swMatePERPENDICULAR,
            "distance" => (int)swMateType_e.swMateDISTANCE,
            _ => (int)swMateType_e.swMateCOINCIDENT,
        };
        var dist = ToMeters(op.Num("distance"), units);
        var alignments = AlignmentsToTry(op, e1, e2, kind);
        var flip = op.Flag("flip");
        try
        {
            var nSel = 0;
            try { nSel = ((ISelectionMgr)model.SelectionManager).GetSelectedObjectCount2(-1); } catch { /* ignore */ }

            Mate2? mate = null;
            var errors = -1;
            var usedAlign = -1;
            var usedFlip = flip;
            foreach (var align in alignments)
            {
                foreach (var tryFlip in flip ? new[] { true, false } : new[] { false, true })
                {
                    model.ClearSelection2(true);
                    SelectMateEntity(assy, c1, e1, append: false, selData, kind, targetR, pickX, pickY, pickZ);
                    SelectMateEntity(assy, c2, e2, append: true, selData, kind, targetR, pickX, pickY, pickZ);
                    errors = 0;
                    mate = assy.AddMate5(mateType, align, tryFlip, dist, dist, dist, 0, 0, 0, 0, 0, false, false, 0, out errors);
                    if (mate is null)
                    {
                        continue;
                    }

                    try { model.EditRebuild3(); } catch { try { model.ForceRebuild3(true); } catch { } }
                    if (MateGeometryOk(assy, kind, c1, e1, c2, e2))
                    {
                        usedAlign = align;
                        usedFlip = tryFlip;
                        errors = 0;
                        goto MateDone;
                    }

                    DeleteLastMate(model);
                    mate = null;
                }
            }

            MateDone:
            var alignName = usedAlign == (int)swMateAlign_e.swMateAlignANTI_ALIGNED
                ? "anti"
                : usedAlign == (int)swMateAlign_e.swMateAlignALIGNED
                    ? "aligned"
                    : usedAlign == (int)swMateAlign_e.swMateAlignCLOSEST
                        ? "closest"
                        : "none";
            Step("AddMate5", mate is not null,
                $"{kind} {c1}/{e1}–{c2}/{e2} sel={nSel} align={alignName} flip={usedFlip} errors={errors}");
            LogComponentBoxes(assy);
        }
        catch (Exception ex)
        {
            Step("AddMate5", false, FormatEx(ex));
        }
        finally
        {
            try { model.ClearSelection2(true); } catch { /* ignore */ }
        }
    }

    private static int[] AlignmentsToTry(CadOperation op, string e1, string e2, string kind)
    {
        var requested = op.Str("align").ToLowerInvariant();
        if (requested is "anti" or "antialigned" or "anti-aligned")
            return [(int)swMateAlign_e.swMateAlignANTI_ALIGNED, (int)swMateAlign_e.swMateAlignALIGNED];
        if (requested is "aligned")
            return [(int)swMateAlign_e.swMateAlignALIGNED, (int)swMateAlign_e.swMateAlignANTI_ALIGNED];
        if (requested is "closest")
            return [(int)swMateAlign_e.swMateAlignCLOSEST, (int)swMateAlign_e.swMateAlignALIGNED, (int)swMateAlign_e.swMateAlignANTI_ALIGNED];

        var a = e1.ToLowerInvariant();
        var b = e2.ToLowerInvariant();
        if (kind is "coincident" && (IsMinMaxEntity(a) || IsMinMaxEntity(b)))
        {
            return
            [
                (int)swMateAlign_e.swMateAlignCLOSEST,
                (int)swMateAlign_e.swMateAlignANTI_ALIGNED,
                (int)swMateAlign_e.swMateAlignALIGNED,
            ];
        }
        var oppositeFaces = (IsTopEntity(a) && IsBottomEntity(b)) || (IsBottomEntity(a) && IsTopEntity(b));
        var shoulderFace = IsShoulderEntity(a) || IsShoulderEntity(b);
        if (kind is "coincident" && (oppositeFaces || shoulderFace))
        {
            return
            [
                (int)swMateAlign_e.swMateAlignANTI_ALIGNED,
                (int)swMateAlign_e.swMateAlignALIGNED,
                (int)swMateAlign_e.swMateAlignCLOSEST,
            ];
        }

        if (kind is "concentric")
        {
            return [(int)swMateAlign_e.swMateAlignALIGNED, (int)swMateAlign_e.swMateAlignANTI_ALIGNED];
        }

        if (kind is "perpendicular")
        {
            return
            [
                (int)swMateAlign_e.swMateAlignALIGNED,
                (int)swMateAlign_e.swMateAlignANTI_ALIGNED,
                (int)swMateAlign_e.swMateAlignCLOSEST,
            ];
        }

        return
        [
            (int)swMateAlign_e.swMateAlignALIGNED,
            (int)swMateAlign_e.swMateAlignANTI_ALIGNED,
            (int)swMateAlign_e.swMateAlignCLOSEST,
        ];
    }

    private static bool IsTopEntity(string e) =>
        e is "top" or "facetop" or "upper" or "faccia-sup" or "facciasup";

    private static bool IsBottomEntity(string e) =>
        e is "bottom" or "facebottom" or "lower" or "faccia-inf" or "facciainf";

    private static bool IsShoulderEntity(string e) =>
        e is "pad" or "boss" or "boss-top" or "faccia-boss" or "shoulder" or "spallamento";

    private static bool IsMinMaxEntity(string e) =>
        e is "xmin" or "xmax" or "ymin" or "ymax" or "zmin" or "zmax";

    private static int MinMaxAxis(string e1, string e2)
    {
        var blob = (e1 + " " + e2).ToLowerInvariant();
        if (blob.Contains("xmin") || blob.Contains("xmax")) return 0;
        if (blob.Contains("ymin") || blob.Contains("ymax")) return 2;
        if (blob.Contains("zmin") || blob.Contains("zmax")) return 4;
        return -1;
    }

    private bool SelectMateEntity(
        IAssemblyDoc assy,
        string key,
        string entity,
        bool append,
        SelectData? selData,
        string mateKind,
        double targetRadiusM = 0,
        double? pickX = null,
        double? pickY = null,
        double? pickZ = null)
    {
        var e = entity.ToLowerInvariant();
        var comp = FindComponent(assy, key);
        if (comp is null)
        {
            Step("FindComponent", false, key);
            return false;
        }

        if (e is "xmin" or "xmax" or "ymin" or "ymax" or "zmin" or "zmax")
        {
            var axis = e[0] == 'x' ? 0 : e[0] == 'y' ? 1 : 2;
            return SelectComponentFaceMinMax(assy, key, axis, wantMax: e.EndsWith("max"), append, selData);
        }

        if (mateKind is "concentric" || e is "hole" or "foro")
        {
            return SelectComponentCylinder(assy, key, append, LooksInner(e, defaultInner: mateKind is "concentric" && append), selData, targetRadiusM, pickX, pickY, pickZ);
        }

        if (e is "inner" or "outer" or "od" or "id")
        {
            if (mateKind is "concentric")
            {
                return SelectComponentCylinder(assy, key, append, LooksInner(e, defaultInner: true), selData, targetRadiusM, pickX, pickY, pickZ);
            }

            return SelectComponentPlanarFace(assy, key, wantTop: e is "outer", append, selData)
                   || SelectComponentCylinder(assy, key, append, LooksInner(e, defaultInner: true), selData, targetRadiusM, pickX, pickY, pickZ);
        }

        if (IsShoulderEntity(e))
        {
            return SelectComponentPlanarFace(assy, key, wantTop: true, append, selData, preferSmallUpper: true);
        }

        if (IsTopEntity(e))
        {
            return SelectComponentPlanarFace(assy, key, wantTop: true, append, selData);
        }

        if (IsBottomEntity(e))
        {
            return SelectComponentPlanarFace(assy, key, wantTop: false, append, selData);
        }

        if (e is "side" or "faccia-lat" or "laterale")
        {
            return SelectComponentPlane(assy, key, "Right", append, selData);
        }

        return SelectComponentPlane(assy, key, entity, append, selData);
    }

    private void DoClearMates(ModelDoc2 model)
    {
        var doomed = new List<Feature>();
        try
        {
            var feat = (Feature)model.FirstFeature();
            while (feat is not null)
            {
                var typeName = "";
                try { typeName = feat.GetTypeName2(); } catch { /* ignore */ }
                if (typeName is "MateGroup" or "MateGroupFeat")
                {
                    var sub = feat.GetFirstSubFeature() as Feature;
                    while (sub is not null)
                    {
                        doomed.Add(sub);
                        sub = sub.GetNextSubFeature() as Feature;
                    }
                }

                feat = feat.GetNextFeature() as Feature;
            }
        }
        catch (Exception ex)
        {
            Step("clearMates", false, FormatEx(ex));
            return;
        }

        if (doomed.Count == 0)
        {
            Step("clearMates", true, "nessun mate");
            return;
        }

        try
        {
            model.ClearSelection2(true);
            foreach (var f in doomed)
            {
                try { f.Select2(true, 0); } catch { /* skip */ }
            }

            model.EditDelete();
            Step("clearMates", true, $"eliminati {doomed.Count} mate");
        }
        catch (Exception ex)
        {
            Step("clearMates", false, FormatEx(ex));
        }
    }

    private void DoInspect(ModelDoc2 model)
    {
        if (model is IAssemblyDoc assy)
        {
            LogComponentBoxes(assy);
            InspectMates(model, assy);
            if (FindBox(assy, "LongheroneSx") is not null)
                VerifyTelaioModule(assy);
            else if (FindBox(assy, "FiancataSx") is not null)
                VerifyScalaModule(assy);
            else
                VerifyGenericAssembly(model, assy);
            return;
        }

        Step("inspect", true, model.GetTitle());
    }

    private void InspectMates(ModelDoc2 model, IAssemblyDoc assy)
    {
        try
        {
            var feat = (Feature)model.FirstFeature();
            var n = 0;
            while (feat is not null)
            {
                string typeName;
                try { typeName = feat.GetTypeName2(); }
                catch { typeName = ""; }

                if (typeName is "MateGroup" or "MateGroupFeat")
                {
                    var sub = feat.GetFirstSubFeature() as Feature;
                    while (sub is not null)
                    {
                        n++;
                        var detail = sub.Name;
                        try
                        {
                            if (sub.GetSpecificFeature2() is IMate2 mate)
                            {
                                var t = mate.Type switch
                                {
                                    0 => "coincident",
                                    1 => "concentric",
                                    5 => "distance",
                                    3 => "parallel",
                                    2 => "perpendicular",
                                    _ => $"type={mate.Type}",
                                };
                                var al = mate.Alignment switch
                                {
                                    0 => "aligned",
                                    1 => "anti",
                                    2 => "closest",
                                    _ => mate.Alignment.ToString(),
                                };
                                detail = $"{sub.Name} {t} {al} flipped={mate.Flipped} ents={mate.GetMateEntityCount()}";
                                for (var i = 0; i < mate.GetMateEntityCount(); i++)
                                {
                                    try
                                    {
                                        var ent = mate.MateEntity(i);
                                        var comp = ent.ReferenceComponent?.Name2 ?? "?";
                                        detail += $" | {comp} refType={ent.ReferenceType2}";
                                    }
                                    catch { /* skip entity */ }
                                }
                            }
                        }
                        catch { /* not a mate */ }

                        Step("inspect.mate", true, detail);
                        sub = sub.GetNextSubFeature() as Feature;
                    }
                }

                feat = feat.GetNextFeature() as Feature;
            }

            if (n == 0) Step("inspect.mate", true, "MateGroup vuoto");
        }
        catch (Exception ex)
        {
            Step("inspect.mate", false, FormatEx(ex));
        }
    }

    private void LogComponentBoxes(IAssemblyDoc assy)
    {
        if (AsArray(assy.GetComponents(false)) is not object[] comps) return;
        foreach (var obj in comps)
        {
            if (obj is not Component2 c) continue;
            var box = ReadBoxMm(c);
            if (box is null) continue;
            Step("bbox", true,
                $"{c.Name2} X[{box[0]:0.00},{box[1]:0.00}] Y[{box[2]:0.00},{box[3]:0.00}] Z[{box[4]:0.00},{box[5]:0.00}]");
        }
    }

    private static double[]? ReadBoxMm(Component2 c)
    {
        try
        {
            var raw = c.GetBox(false, false);
            var d = AsDoubles(raw);
            if (d is null || d.Length < 6) return null;
            return
            [
                d[0] * 1000, d[3] * 1000,
                d[1] * 1000, d[4] * 1000,
                d[2] * 1000, d[5] * 1000,
            ];
        }
        catch
        {
            return null;
        }
    }

    private static double[]? AsDoubles(object? raw)
    {
        if (raw is double[] da) return da;
        if (raw is Array a && a.Length > 0)
        {
            var d = new double[a.Length];
            for (var i = 0; i < a.Length; i++)
            {
                d[i] = Convert.ToDouble(a.GetValue(i));
            }

            return d;
        }

        return null;
    }

    private void DoVerifyLayout(ModelDoc2 model, CadOperation op, string units)
    {
        if (model is not IAssemblyDoc assy)
        {
            Step("verify", false, "non è un assieme");
            return;
        }

        try { model.EditRebuild3(); }
        catch
        {
            try { model.ForceRebuild3(true); } catch { /* ignore */ }
        }

        if (FindBox(assy, "FiancataSx") is not null)
        {
            VerifyScalaModule(assy);
            return;
        }
        if (FindBox(assy, "LongheroneSx") is not null)
        {
            VerifyTelaioModule(assy);
            return;
        }

        var plate = FindBox(assy, "PiastraBase");
        var pin = FindBox(assy, "Perno");
        var wash = FindBox(assy, "Rondella");
        if (plate is null || pin is null || wash is null)
        {
            VerifyGenericAssembly(model, assy);
            return;
        }

        var dx = plate[1] - plate[0];
        var dy = plate[3] - plate[2];
        var dz = plate[5] - plate[4];
        var axis = dy <= dx && dy <= dz ? 2 : dz <= dx && dz <= dy ? 4 : 0;
        var lo = axis;
        var hi = axis + 1;
        var pinThroughPos = pin[lo] < plate[lo] + 1.5 && pin[hi] > plate[hi] + 4;
        var pinThroughNeg = pin[hi] > plate[hi] - 1.5 && pin[lo] < plate[lo] - 4;
        var pinThrough = pinThroughPos || pinThroughNeg;
        var pinCx = (pin[0] + pin[1]) / 2;
        var pinCy = (pin[2] + pin[3]) / 2;
        var pinCz = (pin[4] + pin[5]) / 2;
        var plateCx = (plate[0] + plate[1]) / 2;
        var plateCy = (plate[2] + plate[3]) / 2;
        var plateCz = (plate[4] + plate[5]) / 2;
        var pinOnAxis = axis == 2
            ? Math.Abs(pinCx - plateCx) < 1.5 && Math.Abs(pinCz - plateCz) < 1.5
            : axis == 4
                ? Math.Abs(pinCx - plateCx) < 1.5 && Math.Abs(pinCy - plateCy) < 1.5
                : Math.Abs(pinCy - plateCy) < 1.5 && Math.Abs(pinCz - plateCz) < 1.5;
        var washOnPlus = Math.Abs(wash[lo] - plate[hi]) < 0.8;
        var washOnMinus = Math.Abs(wash[hi] - plate[lo]) < 0.8;
        var washOnPlate = washOnPlus || washOnMinus;
        var washThick = wash[hi] - wash[lo];
        var washOutside = washOnPlus ? wash[hi] >= plate[hi] - 0.2 : wash[lo] <= plate[lo] + 0.2;
        var ok = pinThrough && pinOnAxis && washOnPlate && washOutside && washThick < 4;
        var axisName = axis == 2 ? "Y" : axis == 4 ? "Z" : "X";
        Step("verify", ok,
            $"axis={axisName} pinThrough={pinThrough} pinAxis={pinOnAxis} washOnPlate={washOnPlate} washOut={washOutside} " +
            $"plate={plate[lo]:0.02}..{plate[hi]:0.02} pin={pin[lo]:0.02}..{pin[hi]:0.02} wash={wash[lo]:0.02}..{wash[hi]:0.02}");
        LogComponentBoxes(assy);
    }

    /// <summary>
    /// Assieme generico: ≥2 componenti. Se il payload chiede concentric, resta
    /// concentric≥1 e (coaxial|seated). Se chiede coincident+perpendicular
    /// (telaio a U), coincident≥1, perpendicular≥1, seated e piastre a 90°.
    /// Se chiede solo coincident (cubo/cilindro sulla piastra, staffa a due
    /// piastre), coincident≥1 e seated basta.
    /// </summary>
    private void VerifyGenericAssembly(ModelDoc2 model, IAssemblyDoc assy)
    {
        var items = new List<(string Name, double[] Box)>();
        if (AsArray(assy.GetComponents(false)) is object[] comps)
        {
            foreach (var obj in comps)
            {
                if (obj is not Component2 c) continue;
                var suppressed = false;
                try { suppressed = c.IsSuppressed(); } catch { /* keep */ }
                if (suppressed) continue;
                var box = ReadBoxMm(c);
                if (box is null) continue;
                items.Add((c.Name2 ?? "?", box));
            }
        }

        LogComponentBoxes(assy);
        if (items.Count < 2)
        {
            Step("verify", false, $"componenti={items.Count} (servono ≥2 parti)");
            return;
        }

        var concentric = CountMatesOfType(model, 1);
        var coincident = CountMatesOfType(model, 0);
        var perpendicular = CountMatesOfType(model, 2);
        var coaxial = false;
        var seated = false;
        var seatedShoulder = false;
        var platesPerp = false;
        var shortEndWalls = 0;
        var pairInfo = "";
        for (var i = 0; i < items.Count; i++)
        {
            for (var j = i + 1; j < items.Count; j++)
            {
                var a = items[i].Box;
                var b = items[j].Box;
                var dx = Math.Abs((a[0] + a[1]) / 2 - (b[0] + b[1]) / 2);
                var dy = Math.Abs((a[2] + a[3]) / 2 - (b[2] + b[3]) / 2);
                var dz = Math.Abs((a[4] + a[5]) / 2 - (b[4] + b[5]) / 2);
                var aligned = (dx < 3 ? 1 : 0) + (dy < 3 ? 1 : 0) + (dz < 3 ? 1 : 0);
                var face = FacesTouch(a, b);
                var plateBox = PreferPlateBox(a, b);
                var otherBox = ReferenceEquals(plateBox, a) ? b : a;
                CapExtents(plateBox, otherBox, out var capAbove, out var capBelow);
                var shoulder = ShoulderCapSeated(plateBox, otherBox);
                if (shoulder)
                {
                    face = true;
                    seatedShoulder = true;
                }

                if (ThicknessAxis(a) != ThicknessAxis(b))
                    platesPerp = true;
                if (face) seated = true;
                if (ThroughHoleSeated(plateBox, otherBox)) seated = true;
                if (aligned >= 2) coaxial = true;
                var plateAxis = ThicknessAxis(plateBox);
                var wallAxis = ThicknessAxis(otherBox);
                if (face && wallAxis == 0 && plateAxis == 2)
                {
                    var pLo = Math.Min(plateBox[0], plateBox[1]);
                    var pHi = Math.Max(plateBox[0], plateBox[1]);
                    var cx = (otherBox[0] + otherBox[1]) / 2.0;
                    if (Math.Abs(cx - pLo) < 22 || Math.Abs(cx - pHi) < 22)
                        shortEndWalls++;
                }
                if (face || string.IsNullOrEmpty(pairInfo))
                {
                    pairInfo =
                        $"{items[i].Name}/{items[j].Name} dX={dx:0.02} dY={dy:0.02} dZ={dz:0.02} aligned={aligned} face={face} capAbove={capAbove:0.02} capBelow={capBelow:0.02}";
                }
            }
        }

        var wantConcentric = PayloadRequestsMateKind("concentric");
        var wantCoincident = PayloadRequestsMateKind("coincident");
        var wantPerpendicular = PayloadRequestsMateKind("perpendicular");
        var concentricOk = concentric >= 1 && (coaxial || seated);
        var coincidentOk = coincident >= 1 && seated;
        string rule;
        bool ok;
        var sandwichOk = SandwichBothFaces(items, out var sandwichFaces, out var sandwichInfo);
        if (wantConcentric && wantCoincident && wantPerpendicular && items.Count >= 3)
        {
            // Base + colonna + piastra: seated su entrambe le facce, non la regola T-bar a 2 pezzi.
            ok = concentric >= 1 && coincident >= 2 && perpendicular >= 1 && coaxial && sandwichOk;
            rule = "concentric+coincident+perpendicular+sandwich+seated";
            if (!string.IsNullOrEmpty(sandwichInfo))
                pairInfo = string.IsNullOrEmpty(pairInfo) ? sandwichInfo : sandwichInfo + " " + pairInfo;
        }
        else if (wantConcentric && wantCoincident && wantPerpendicular)
        {
            // Barra a T: il bbox non è simmetrico (testa da un lato), coaxial bbox-center
            // fallisce anche con i fori Ø8 già concentrici. Il mate concentric è la prova.
            ok = concentric >= 1 && coincident >= 1 && perpendicular >= 1 &&
                 (seatedShoulder || seated);
            rule = seatedShoulder ? "concentric+pad+perpendicular" : "concentric+coincident+perpendicular+seated";
        }
        else if (wantConcentric && wantCoincident && items.Count >= 3)
        {
            ok = concentric >= 1 && coincident >= 2 && coaxial && sandwichOk;
            rule = "concentric+sandwich+seated";
            if (!string.IsNullOrEmpty(sandwichInfo))
                pairInfo = string.IsNullOrEmpty(pairInfo) ? sandwichInfo : sandwichInfo + " " + pairInfo;
        }
        else if (wantConcentric && wantCoincident)
        {
            // Boccola su un foro fuori origine: il bbox non è coassiale al centro piastra
            // (dZ = passo/2). Il mate concentric + seated sulla faccia basta.
            ok = concentric >= 1 && (coaxial || seatedShoulder || seated);
            rule = seatedShoulder ? "concentric+seated" : "concentric+coincident+seated";
        }
        else if (wantCoincident && wantPerpendicular)
        {
            ok = coincident >= 1 && perpendicular >= 1 && seated && platesPerp &&
                 (items.Count < 3 || shortEndWalls >= 2);
            rule = "coincident+perpendicular+seated";
        }
        else if (wantConcentric)
        {
            ok = concentricOk;
            rule = "concentric";
        }
        else if (wantCoincident)
        {
            ok = coincidentOk;
            rule = "coincident+seated";
        }
        else if (wantPerpendicular)
        {
            ok = perpendicular >= 1 && platesPerp;
            rule = "perpendicular";
        }
        else
        {
            ok = concentricOk || coincidentOk;
            rule = "either";
        }

        Step("verify", ok,
            $"n={items.Count} concentric={concentric} coincident={coincident} perpendicular={perpendicular} coaxial={coaxial} seated={seated} sandwich={sandwichFaces} perpGeom={platesPerp} shortEndWalls={shortEndWalls} rule={rule} {pairInfo}");
    }

    private bool PayloadRequestsMateKind(string kind)
    {
        foreach (var op in _ops)
        {
            if (!string.Equals(op.Type, "mate", StringComparison.OrdinalIgnoreCase))
                continue;
            var mt = op.Str("mateType", op.Str("subtype", op.Str("kind"))).Trim().ToLowerInvariant();
            if (mt == kind)
                return true;
        }

        return false;
    }

    private static bool FacesTouch(double[] a, double[] b)
    {
        for (var axis = 0; axis <= 4; axis += 2)
        {
            var aLo = Math.Min(a[axis], a[axis + 1]);
            var aHi = Math.Max(a[axis], a[axis + 1]);
            var bLo = Math.Min(b[axis], b[axis + 1]);
            var bHi = Math.Max(b[axis], b[axis + 1]);
            if (Math.Abs(aLo - bHi) >= 2.5 && Math.Abs(bLo - aHi) >= 2.5)
                continue;
            var overlap = true;
            for (var o = 0; o <= 4; o += 2)
            {
                if (o == axis) continue;
                var aO0 = Math.Min(a[o], a[o + 1]);
                var aO1 = Math.Max(a[o], a[o + 1]);
                var bO0 = Math.Min(b[o], b[o + 1]);
                var bO1 = Math.Max(b[o], b[o + 1]);
                if (Math.Min(aO1, bO1) - Math.Max(aO0, bO0) < -1.5)
                    overlap = false;
            }

            if (overlap) return true;
        }

        return false;
    }

    /// <summary>
    /// Distanziale in mezzo a due piastre: contatto su entrambe le facce
    /// (non due piastre dallo stesso lato). Asse = spessore delle piastre.
    /// </summary>
    private static bool SandwichBothFaces(
        List<(string Name, double[] Box)> items,
        out int faces,
        out string detail)
    {
        faces = 0;
        detail = "";
        if (items.Count != 3) return false;

        var ordered = items.OrderByDescending(i => PlateFootprint(i.Box)).ToList();
        var p1 = ordered[0];
        var p2 = ordered[1];
        var spacer = ordered[2];
        var axis = ThicknessAxis(p1.Box);
        var sLo = Math.Min(spacer.Box[axis], spacer.Box[axis + 1]);
        var sHi = Math.Max(spacer.Box[axis], spacer.Box[axis + 1]);

        bool OnLow(double[] b)
        {
            var hi = Math.Max(b[axis], b[axis + 1]);
            return Math.Abs(hi - sLo) < 2.5 && FacesTouch(b, spacer.Box);
        }

        bool OnHigh(double[] b)
        {
            var lo = Math.Min(b[axis], b[axis + 1]);
            return Math.Abs(lo - sHi) < 2.5 && FacesTouch(b, spacer.Box);
        }

        if (FacesTouch(p1.Box, spacer.Box)) faces++;
        if (FacesTouch(p2.Box, spacer.Box)) faces++;
        var p1Low = OnLow(p1.Box);
        var p1High = OnHigh(p1.Box);
        var p2Low = OnLow(p2.Box);
        var p2High = OnHigh(p2.Box);
        var bothSides = (p1Low && p2High) || (p1High && p2Low);
        detail =
            $"sandwich={faces} bothSides={bothSides} spacer={sLo:0.02}..{sHi:0.02} " +
            $"p1={(p1Low ? "low" : p1High ? "high" : "none")} p2={(p2Low ? "low" : p2High ? "high" : "none")}";
        return bothSides && faces >= 2;
    }

    private static double MinExtent(double[] b)
    {
        var dx = Math.Abs(b[1] - b[0]);
        var dy = Math.Abs(b[3] - b[2]);
        var dz = Math.Abs(b[5] - b[4]);
        return Math.Min(dx, Math.Min(dy, dz));
    }

    private static double[] PreferPlateBox(double[] a, double[] b)
    {
        return PlateFootprint(a) >= PlateFootprint(b) ? a : b;
    }

    private static double PlateFootprint(double[] x)
    {
        var t = ThicknessAxis(x);
        var e0 = Math.Abs(x[1] - x[0]);
        var e1 = Math.Abs(x[3] - x[2]);
        var e2 = Math.Abs(x[5] - x[4]);
        return t == 0 ? e1 * e2 : t == 2 ? e0 * e2 : e0 * e1;
    }

    /// <summary>
    /// Spallamento ØDs×ts seduto sulla faccia della piastra, gambo nel foro:
    /// il cap oltre la piastra è ~ts (4–10 mm) e l'albero attraversa lo spessore.
    /// </summary>
    private static bool ShoulderCapSeated(double[] plate, double[] shaft)
    {
        CapExtents(plate, shaft, out var above, out var below);
        var capTop = above > 3.5 && above < 12 && below > 4;
        var capBot = below > 3.5 && below < 12 && above > 4;
        return capTop || capBot;
    }

    private static void CapExtents(double[] plate, double[] shaft, out double above, out double below)
    {
        var axis = ThicknessAxis(plate);
        var pLo = Math.Min(plate[axis], plate[axis + 1]);
        var pHi = Math.Max(plate[axis], plate[axis + 1]);
        var sLo = Math.Min(shaft[axis], shaft[axis + 1]);
        var sHi = Math.Max(shaft[axis], shaft[axis + 1]);
        above = sHi - pHi;
        below = pLo - sLo;
    }

    /// <summary>
    /// Albero nel foro della flangia, una faccia a filo: il gambo occupa lo spessore
    /// e un’estremità coincide con una faccia (FacesTouch sul bbox fallisce).
    /// </summary>
    private static bool ThroughHoleSeated(double[] plate, double[] shaft)
    {
        var axis = ThicknessAxis(plate);
        var pLo = Math.Min(plate[axis], plate[axis + 1]);
        var pHi = Math.Max(plate[axis], plate[axis + 1]);
        var sLo = Math.Min(shaft[axis], shaft[axis + 1]);
        var sHi = Math.Max(shaft[axis], shaft[axis + 1]);
        var occupies = sLo < pHi - 0.8 && sHi > pLo + 0.8;
        var flushLow = Math.Abs(sLo - pLo) < 2.5;
        var flushHigh = Math.Abs(sHi - pHi) < 2.5;
        var sticks = (flushLow && sHi > pHi + 4) || (flushHigh && sLo < pLo - 4);
        return occupies && (flushLow || flushHigh) && sticks;
    }

    private int CountMatesOfType(ModelDoc2 model, int mateType)
    {
        var n = 0;
        try
        {
            var feat = (Feature)model.FirstFeature();
            while (feat is not null)
            {
                string typeName;
                try { typeName = feat.GetTypeName2(); }
                catch { typeName = ""; }

                if (typeName is "MateGroup" or "MateGroupFeat")
                {
                    var sub = feat.GetFirstSubFeature() as Feature;
                    while (sub is not null)
                    {
                        try
                        {
                            if (sub.GetSpecificFeature2() is IMate2 mate && mate.Type == mateType)
                                n++;
                        }
                        catch { /* not a mate */ }

                        sub = sub.GetNextSubFeature() as Feature;
                    }
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

    private double[]? FindBox(IAssemblyDoc assy, string key)
    {
        var c = FindComponent(assy, key);
        return c is null ? null : ReadBoxMm(c);
    }

    /// <summary>
    /// Modulo scala: due fiancate parallele, scalini che riempiono la luce, fori coassiali Z.
    /// </summary>
    private void VerifyScalaModule(IAssemblyDoc assy)
    {
        var sx = FindBox(assy, "FiancataSx");
        var dx = FindBox(assy, "FiancataDx");
        var s1 = FindBox(assy, "Scalino1");
        var s2 = FindBox(assy, "Scalino2");
        var piede = FindBox(assy, "Piede");
        if (sx is null || dx is null || s1 is null || s2 is null)
        {
            Step("verifyScala", false, $"box mancanti sx={sx is not null} dx={dx is not null} s1={s1 is not null} s2={s2 is not null}");
            return;
        }

        var sxZ0 = Math.Min(sx[4], sx[5]);
        var sxZ1 = Math.Max(sx[4], sx[5]);
        var dxZ0 = Math.Min(dx[4], dx[5]);
        var dxZ1 = Math.Max(dx[4], dx[5]);
        double inner0, inner1;
        if (dxZ0 >= sxZ1 - 1)
        {
            inner0 = sxZ1;
            inner1 = dxZ0;
        }
        else if (sxZ0 >= dxZ1 - 1)
        {
            inner0 = dxZ1;
            inner1 = sxZ0;
        }
        else
        {
            Step("verifyScala", false, $"fiancate non affacciate SxZ[{sxZ0:0},{sxZ1:0}] DxZ[{dxZ0:0},{dxZ1:0}]");
            return;
        }

        var luce = inner1 - inner0;
        var s1Z0 = Math.Min(s1[4], s1[5]);
        var s1Z1 = Math.Max(s1[4], s1[5]);
        var s2Z0 = Math.Min(s2[4], s2[5]);
        var s2Z1 = Math.Max(s2[4], s2[5]);
        var span = s1Z1 - s1Z0;
        var x1 = 0.5 * (s1[0] + s1[1]);
        var x2 = 0.5 * (s2[0] + s2[1]);
        var yOverlap = Math.Min(s1[3], sx[3]) - Math.Max(s1[2], sx[2]);
        var flush = Math.Abs(s1Z0 - inner0) < 4 && Math.Abs(s1Z1 - inner1) < 4
                    && Math.Abs(s2Z0 - inner0) < 4 && Math.Abs(s2Z1 - inner1) < 4;
        var holesX = Math.Abs(Math.Abs(x1) - 220) < 15 && Math.Abs(Math.Abs(x2) - 220) < 15 && x1 * x2 < 0;
        var rails = Math.Abs((sx[1] - sx[0]) - 600) < 5 && Math.Abs((sx[3] - sx[2]) - 40) < 5;
        var ok = luce > 400 && Math.Abs(span - luce) < 8 && flush && yOverlap > 10 && holesX && rails;
        Step("verifyScala", ok,
            $"luce={luce:0.0} mm spanScalino={span:0.0} flush={flush} yOverlap={yOverlap:0.0} xS1={x1:0} xS2={x2:0} piede={piede is not null}");
    }

    private void VerifyTelaioModule(IAssemblyDoc assy)
    {
        var sx = FindBox(assy, "LongheroneSx");
        var dx = FindBox(assy, "LongheroneDx");
        var p1 = FindBox(assy, "Pioli1");
        var p2 = FindBox(assy, "Pioli2");
        var p3 = FindBox(assy, "Pioli3");
        var fl = FindBox(assy, "Flangia");
        if (sx is null || dx is null || p1 is null || p2 is null || p3 is null)
        {
            Step("verifyTelaio", false, "box mancanti");
            return;
        }

        var sxZ1 = Math.Max(sx[4], sx[5]);
        var dxZ0 = Math.Min(dx[4], dx[5]);
        var luce = dxZ0 - sxZ1;
        bool Flush(double[] b) =>
            Math.Abs(Math.Min(b[4], b[5]) - sxZ1) < 5 && Math.Abs(Math.Max(b[4], b[5]) - dxZ0) < 5;
        var xs = new[] { 0.5 * (p1[0] + p1[1]), 0.5 * (p2[0] + p2[1]), 0.5 * (p3[0] + p3[1]) };
        Array.Sort(xs);
        var pitch = Math.Abs(xs[1] - xs[0]) > 80 && Math.Abs(xs[2] - xs[1]) > 80;
        var ok = luce > 400 && Flush(p1) && Flush(p2) && Flush(p3) && pitch && fl is not null;
        Step("verifyTelaio", ok,
            $"luce={luce:0.0} flush={Flush(p1)&&Flush(p2)&&Flush(p3)} x=[{xs[0]:0},{xs[1]:0},{xs[2]:0}] flangia={fl is not null}");
    }

    private bool SelectComponentPlanarFace(
        IAssemblyDoc assy,
        string key,
        bool wantTop,
        bool append,
        SelectData? selData,
        bool preferSmallUpper = false)
    {
        var comp = FindComponent(assy, key);
        if (comp is null) return false;
        if (comp.GetModelDoc2() is not IPartDoc part) return false;

        IFace2? best = null;
        var bestT = wantTop ? double.MinValue : double.MaxValue;
        var bestArea = preferSmallUpper ? double.MaxValue : double.MinValue;
        if (!TryCylinderAxis(part, out var ax, out var ay, out var az, out var px, out var py, out var pz))
        {
            ax = 0; ay = 1; az = 0;
            px = py = pz = 0;
        }

        var cands = new List<(IFace2 Face, double T, double Area)>();
        try
        {
            if (AsArray(part.GetBodies2((int)swBodyType_e.swSolidBody, true)) is not object[] bodies)
            {
                return false;
            }

            foreach (var bObj in bodies)
            {
                if (bObj is not Body2 body) continue;
                if (AsArray(body.GetFaces()) is not object[] faces) continue;
                foreach (var fObj in faces)
                {
                    if (fObj is not IFace2 face) continue;
                    ISurface? surf = null;
                    try { surf = face.GetSurface() as ISurface; } catch { continue; }
                    if (surf is null) continue;
                    var isPlane = false;
                    try { isPlane = surf.IsPlane(); } catch { continue; }
                    if (!isPlane) continue;

                    double nx = 0, ny = 0, nz = 1, qx = 0, qy = 0, qz = 0;
                    try
                    {
                        var d = AsDoubles(surf.PlaneParams);
                        if (d is { Length: >= 6 })
                        {
                            nx = d[0]; ny = d[1]; nz = d[2];
                            qx = d[3]; qy = d[4]; qz = d[5];
                        }
                    }
                    catch { continue; }

                    var ndot = nx * ax + ny * ay + nz * az;
                    if (Math.Abs(ndot) < 0.85) continue;

                    var t = (qx - px) * ax + (qy - py) * ay + (qz - pz) * az;
                    double area = 0;
                    try { area = face.GetArea(); } catch { area = 0; }
                    cands.Add((face, t, area));
                }
            }
        }
        catch
        {
            return false;
        }

        if (cands.Count == 0) return false;

        if (wantTop && preferSmallUpper)
        {
            var tMin = cands.Min(c => c.T);
            var tMax = cands.Max(c => c.T);
            // Faccia anulare dello spallamento: tra l'estremo del cap e l'estremo del gambo,
            // non il disco Ø10 in cima all'albero.
            var annular = cands
                .Where(c => c.T > tMin + 0.0004 && c.T < tMax - 0.0004 && c.Area > 2e-5)
                .OrderBy(c => c.Area)
                .ToList();
            if (annular.Count > 0)
            {
                var pickA = annular.First();
                best = pickA.Face;
                bestT = pickA.T;
                bestArea = pickA.Area;
            }
            else
            {
                var upper = cands.Where(c => c.T > tMin + 0.0004 && c.Area > 2e-5).ToList();
                if (upper.Count == 0) upper = cands.Where(c => c.T > tMin + 0.0004).ToList();
                if (upper.Count == 0) upper = cands;
                var pick = upper.OrderBy(c => c.Area).ThenByDescending(c => c.T).First();
                best = pick.Face;
                bestT = pick.T;
                bestArea = pick.Area;
            }
        }
        else if (wantTop)
        {
            // `top` = faccia planare all'estremo T (corona del boss), non l'area maggiore:
            // su piastra+boss l'area maggiore è la piastra, ~2 mm sotto la corona Ø18.
            var tMin = cands.Min(c => c.T);
            var upper = cands.Where(c => c.T > tMin + 0.0004).ToList();
            if (upper.Count == 0) upper = cands;
            var pick = upper.OrderByDescending(c => c.T).ThenByDescending(c => c.Area).First();
            best = pick.Face;
            bestT = pick.T;
            bestArea = pick.Area;
        }
        else
        {
            foreach (var c in cands)
            {
                if (c.T < bestT) { bestT = c.T; best = c.Face; bestArea = c.Area; }
            }
        }

        if (best is null) return false;
        try
        {
            var corr = comp.GetCorresponding(best);
            var ok = corr is IEntity ent && ent.Select4(append, selData);
            if (ok)
            {
                Step("selectFace", true,
                    $"{key} {(preferSmallUpper ? "pad" : wantTop ? "top" : "bottom")} t={bestT * 1000:0.02} mm area={bestArea * 1e6:0.0} mm2");
            }

            return ok;
        }
        catch
        {
            return false;
        }
    }

    private static bool TryCylinderAxis(
        IPartDoc part,
        out double ax, out double ay, out double az,
        out double px, out double py, out double pz)
    {
        ax = ay = az = px = py = pz = 0;
        var bestR = double.MaxValue;
        var found = false;
        try
        {
            if (AsArray(part.GetBodies2((int)swBodyType_e.swSolidBody, true)) is not object[] bodies)
            {
                return false;
            }

            foreach (var bObj in bodies)
            {
                if (bObj is not Body2 body) continue;
                if (AsArray(body.GetFaces()) is not object[] faces) continue;
                foreach (var fObj in faces)
                {
                    if (fObj is not IFace2 face) continue;
                    ISurface? surf = null;
                    try { surf = face.GetSurface() as ISurface; } catch { continue; }
                    if (surf is null) continue;
                    var isCyl = false;
                    try { isCyl = surf.IsCylinder(); } catch { continue; }
                    if (!isCyl) continue;
                    var d = AsDoubles(surf.CylinderParams);
                    if (d is null || d.Length < 7) continue;
                    var r = Math.Abs(d[6]);
                    if (!found || r < bestR)
                    {
                        found = true;
                        bestR = r;
                        px = d[0]; py = d[1]; pz = d[2];
                        ax = d[3]; ay = d[4]; az = d[5];
                    }
                }
            }
        }
        catch
        {
            return false;
        }

        var mag = Math.Sqrt(ax * ax + ay * ay + az * az);
        if (!found || mag < 1e-12) return false;
        ax /= mag; ay /= mag; az /= mag;
        return true;
    }

    private bool MateGeometryOk(IAssemblyDoc assy, string kind, string c1, string e1, string c2, string e2)
    {
        if (kind is "perpendicular")
        {
            var b1 = FindBox(assy, c1);
            var b2 = FindBox(assy, c2);
            if (b1 is not null && b2 is not null)
            {
                // Staffa a Z: altezza 28 e larghezza 30, entrambe ~Y/X; l’asse più sottile
                // coincide con la piastra (Y) anche se Right ⊥ Top è vero.
                if (ThicknessAxis(b1) != ThicknessAxis(b2)) return true;
                return FacesTouch(b1, b2);
            }
            return true;
        }

        if (kind is "coincident")
        {
            var b1 = FindBox(assy, c1);
            var b2 = FindBox(assy, c2);
            if (b1 is not null && b2 is not null)
            {
                var plateBox = PreferPlateBox(b1, b2);
                var otherBox = ReferenceEquals(plateBox, b1) ? b2 : b1;
                if (IsShoulderEntity(e1.ToLowerInvariant()) || IsShoulderEntity(e2.ToLowerInvariant()))
                {
                    var seated = ShoulderCapSeated(plateBox, otherBox);
                    if (!seated)
                    {
                        CapExtents(plateBox, otherBox, out var above, out var below);
                        Console.WriteLine(
                            $"[{DateTime.Now:HH:mm:ss}] mateGeom spallamento non seduto capAbove={above:0.02} capBelow={below:0.02}");
                    }

                    return seated;
                }

                if (IsMinMaxEntity(e1.ToLowerInvariant()) || IsMinMaxEntity(e2.ToLowerInvariant()))
                {
                    var mmAxis = MinMaxAxis(e1, e2);
                    if (mmAxis >= 0)
                    {
                        var eA = Math.Abs(b1[mmAxis + 1] - b1[mmAxis]);
                        var eB = Math.Abs(b2[mmAxis + 1] - b2[mmAxis]);
                        var wall = Math.Min(eA, eB);
                        // Parete sul lato corto: spessore ~t sull'asse del mate, non ruotata sul lato lungo.
                        return FacesTouch(b1, b2) && wall < 14;
                    }
                }

                var touch = FacesTouch(b1, b2) || ShoulderCapSeated(plateBox, otherBox);
                var through = ThroughHoleSeated(plateBox, otherBox);
                if (PayloadRequestsMateKind("concentric"))
                {
                    var thAxis = ThicknessAxis(plateBox);
                    var otherLen = Math.Abs(otherBox[thAxis + 1] - otherBox[thAxis]);
                    var plateT = Math.Abs(plateBox[thAxis + 1] - plateBox[thAxis]);
                    // Vite/perno lunghi (2 PRT): la coincidente a filo deve attraversare il foro.
                    // Colonna/distanziale in uno stack a 3 componenti: appoggio sulla faccia (FacesTouch).
                    if (otherLen > plateT + 8)
                    {
                        if (CountVisibleComponents(assy) >= 3)
                            return through || ShoulderCapSeated(plateBox, otherBox) || touch;
                        return through || ShoulderCapSeated(plateBox, otherBox);
                    }
                }

                return touch || through;
            }
        }

        if (kind is "concentric")
        {
            var b1c = FindBox(assy, c1);
            var b2c = FindBox(assy, c2);
            if (b1c is not null && b2c is not null && PayloadRequestsMateKind("coincident"))
            {
                var plateBoxC = PreferPlateBox(b1c, b2c);
                var otherBoxC = ReferenceEquals(plateBoxC, b1c) ? b2c : b1c;
                var thAxisC = ThicknessAxis(plateBoxC);
                var otherLenC = Math.Abs(otherBoxC[thAxisC + 1] - otherBoxC[thAxisC]);
                var plateTC = Math.Abs(plateBoxC[thAxisC + 1] - plateBoxC[thAxisC]);
                if (otherLenC > plateTC + 8)
                {
                    if (CountVisibleComponents(assy) >= 3)
                    {
                        return ThroughHoleSeated(plateBoxC, otherBoxC)
                            || ShoulderCapSeated(plateBoxC, otherBoxC)
                            || FacesTouch(b1c, b2c);
                    }

                    return ThroughHoleSeated(plateBoxC, otherBoxC) || ShoulderCapSeated(plateBoxC, otherBoxC);
                }
            }
        }

        var plate = FindBox(assy, "PiastraBase");
        var pin = FindBox(assy, "Perno");
        var wash = FindBox(assy, "Rondella");
        if (plate is null) return true;
        var axis = ThicknessAxis(plate);
        var lo = axis;
        var hi = axis + 1;

        bool OnAxis(double[] box) =>
            axis == 2
                ? Math.Abs((box[0] + box[1]) / 2 - (plate[0] + plate[1]) / 2) < 2
                  && Math.Abs((box[4] + box[5]) / 2 - (plate[4] + plate[5]) / 2) < 2
                : axis == 4
                    ? Math.Abs((box[0] + box[1]) / 2 - (plate[0] + plate[1]) / 2) < 2
                      && Math.Abs((box[2] + box[3]) / 2 - (plate[2] + plate[3]) / 2) < 2
                    : Math.Abs((box[2] + box[3]) / 2 - (plate[2] + plate[3]) / 2) < 2
                      && Math.Abs((box[4] + box[5]) / 2 - (plate[4] + plate[5]) / 2) < 2;

        if (kind is "concentric")
        {
            if (LooksLike(c1, "perno") || LooksLike(c2, "perno") || LooksLike(c1, "c2") || LooksLike(c2, "c2"))
            {
                return pin is not null && OnAxis(pin);
            }

            if (LooksLike(c1, "rondella") || LooksLike(c2, "rondella") || LooksLike(c1, "c3") || LooksLike(c2, "c3"))
            {
                return wash is not null && OnAxis(wash);
            }

            return true;
        }

        if (kind is "coincident" && pin is not null && (LooksLike(c1, "perno") || LooksLike(c2, "perno") || LooksLike(c1, "c2") || LooksLike(c2, "c2")))
        {
            var throughPos = pin[lo] < plate[lo] + 1.5 && pin[hi] > plate[hi] + 4;
            var throughNeg = pin[hi] > plate[hi] - 1.5 && pin[lo] < plate[lo] - 4;
            return throughPos || throughNeg;
        }

        if (kind is "coincident" && wash is not null && (LooksLike(c1, "rondella") || LooksLike(c2, "rondella") || LooksLike(c1, "c3") || LooksLike(c2, "c3")))
        {
            var onPlus = Math.Abs(wash[lo] - plate[hi]) < 1.0;
            var onMinus = Math.Abs(wash[hi] - plate[lo]) < 1.0;
            return onPlus || onMinus;
        }

        return true;
    }

    private static bool LooksLike(string key, string token) =>
        key.Contains(token, StringComparison.OrdinalIgnoreCase);

    private static int CountVisibleComponents(IAssemblyDoc assy)
    {
        if (AsArray(assy.GetComponents(false)) is not object[] comps) return 0;
        return comps.OfType<Component2>().Count();
    }

    private static int ThicknessAxis(double[] plate)
    {
        var dx = plate[1] - plate[0];
        var dy = plate[3] - plate[2];
        var dz = plate[5] - plate[4];
        return dy <= dx && dy <= dz ? 2 : dz <= dx && dz <= dy ? 4 : 0;
    }

    private void DeleteLastMate(ModelDoc2 model)
    {
        Feature? last = null;
        try
        {
            var feat = (Feature)model.FirstFeature();
            while (feat is not null)
            {
                var tn = "";
                try { tn = feat.GetTypeName2(); } catch { /* ignore */ }
                if (tn is "MateGroup" or "MateGroupFeat")
                {
                    var sub = feat.GetFirstSubFeature() as Feature;
                    while (sub is not null)
                    {
                        last = sub;
                        sub = sub.GetNextSubFeature() as Feature;
                    }
                }

                feat = feat.GetNextFeature() as Feature;
            }

            if (last is null) return;
            model.ClearSelection2(true);
            last.Select2(false, 0);
            model.EditDelete();
        }
        catch
        {
            /* best effort */
        }
    }

    private static SelectData? CreateMark1(ModelDoc2 model)
    {
        try
        {
            var selMgr = (ISelectionMgr)model.SelectionManager;
            var data = (SelectData)selMgr.CreateSelectData();
            data.Mark = 1;
            return data;
        }
        catch
        {
            return null;
        }
    }

    private bool SelectComponentPlane(IAssemblyDoc assy, string key, string plane, bool append, SelectData? selData)
    {
        var comp = FindComponent(assy, key);
        if (comp is null) return false;
        var aliases = PlaneAliases(plane);
        if (comp.GetModelDoc2() is not ModelDoc2 part) return false;

        Feature? feat = FeatureTreeReader.FindByTypeAndAlias(part, "RefPlane", aliases);
        if (feat is null)
        {
            var all = FeatureTreeReader.Read(part).Where(f => f.TypeName is "RefPlane" or "OriginProfileFeature").ToList();
            var match = all.FirstOrDefault(f =>
                aliases.Any(a => f.Name.Equals(a, StringComparison.OrdinalIgnoreCase)) ||
                f.Name.Contains(plane, StringComparison.OrdinalIgnoreCase));
            if (match is not null)
            {
                feat = (Feature)part.FeatureByPositionReverse(match.Index);
            }
            else if (plane.Equals("origin", StringComparison.OrdinalIgnoreCase))
            {
                var origin = all.FirstOrDefault(f => f.TypeName == "OriginProfileFeature");
                if (origin is not null) feat = (Feature)part.FeatureByPositionReverse(origin.Index);
            }
        }

        if (feat is null) return false;

        try
        {
            var corr = comp.GetCorresponding(feat);
            if (corr is IEntity ent)
            {
                return ent.Select4(append, selData);
            }
        }
        catch
        {
            /* fall through */
        }

        try { return feat.Select2(append, 1); }
        catch { return false; }
    }

    private static bool LooksInner(string entity, bool defaultInner = false)
    {
        var e = entity.ToLowerInvariant();
        if (e is "inner" or "foro" or "hole" or "bore") return true;
        if (e is "outer" or "outercyl" or "external") return false;
        return defaultInner;
    }

    private bool SelectComponentCylinder(IAssemblyDoc assy, string key, bool append, bool preferInner, SelectData? selData, double targetRadiusM = 0, double? pickX = null, double? pickY = null, double? pickZ = null)
    {
        var comp = FindComponent(assy, key);
        if (comp is null) return false;
        if (comp.GetModelDoc2() is not IPartDoc part) return false;

        IFace2? best = null;
        var bestScore = double.MaxValue;
        var bestR = 0.0;
        try
        {
            if (AsArray(part.GetBodies2((int)swBodyType_e.swSolidBody, true)) is not object[] bodies)
            {
                return false;
            }

            foreach (var bObj in bodies)
            {
                if (bObj is not Body2 body) continue;
                if (AsArray(body.GetFaces()) is not object[] faces) continue;
                foreach (var fObj in faces)
                {
                    if (fObj is not IFace2 face) continue;
                    ISurface? surf = null;
                    try { surf = face.GetSurface() as ISurface; } catch { continue; }
                    if (surf is null) continue;
                    var isCyl = false;
                    try { isCyl = surf.IsCylinder(); } catch { continue; }
                    if (!isCyl) continue;
                    double r = 0, ox = 0, oy = 0, oz = 0;
                    try
                    {
                        var cp = AsDoubles(surf.CylinderParams);
                        if (cp is { Length: >= 7 })
                        {
                            ox = cp[0]; oy = cp[1]; oz = cp[2];
                            r = Math.Abs(cp[6]);
                        }
                    }
                    catch { /* keep 0 */ }

                    if (targetRadiusM > 1e-8 && Math.Abs(r - targetRadiusM) > 0.0006)
                        continue;

                    double score;
                    if (pickX is not null || pickY is not null || pickZ is not null)
                    {
                        score = 0;
                        if (pickX is not null) score += Math.Abs(ox - pickX.Value);
                        if (pickY is not null) score += Math.Abs(oy - pickY.Value);
                        if (pickZ is not null) score += Math.Abs(oz - pickZ.Value);
                    }
                    else if (targetRadiusM > 1e-8)
                    {
                        score = Math.Abs(r - targetRadiusM);
                    }
                    else
                    {
                        score = preferInner ? r : -r;
                    }

                    if (score < bestScore)
                    {
                        bestScore = score;
                        bestR = r;
                        best = face;
                    }
                }
            }
        }
        catch
        {
            return false;
        }

        if (best is null) return false;
        try
        {
            var corr = comp.GetCorresponding(best);
            var ok = corr is IEntity ent && ent.Select4(append, selData);
            if (ok)
            {
                var mode = targetRadiusM > 1e-8 ? $"targetR={targetRadiusM * 1000:0.02}" : (preferInner ? "inner" : "outer");
                Step("selectCyl", true, $"{key} {mode} R={bestR * 1000:0.02} mm");
            }

            return ok;
        }
        catch
        {
            return false;
        }
    }

    private bool SelectComponentFaceMinMax(
        IAssemblyDoc assy,
        string key,
        int axis,
        bool wantMax,
        bool append,
        SelectData? selData)
    {
        var comp = FindComponent(assy, key);
        if (comp is null) return false;
        if (comp.GetModelDoc2() is not IPartDoc part) return false;

        IFace2? best = null;
        var bestT = wantMax ? double.MinValue : double.MaxValue;
        var bestArea = 0.0;
        try
        {
            if (AsArray(part.GetBodies2((int)swBodyType_e.swSolidBody, true)) is not object[] bodies)
                return false;
            foreach (var bObj in bodies)
            {
                if (bObj is not Body2 body) continue;
                if (AsArray(body.GetFaces()) is not object[] faces) continue;
                foreach (var fObj in faces)
                {
                    if (fObj is not IFace2 face) continue;
                    ISurface? surf = null;
                    try { surf = face.GetSurface() as ISurface; } catch { continue; }
                    if (surf is null) continue;
                    var isPlane = false;
                    try { isPlane = surf.IsPlane(); } catch { continue; }
                    if (!isPlane) continue;

                    var d = AsDoubles(surf.PlaneParams);
                    if (d is null || d.Length < 6) continue;
                    var t = axis switch
                    {
                        0 => d[3],
                        1 => d[4],
                        _ => d[5],
                    };
                    double area = 0;
                    try { area = face.GetArea(); } catch { /* ignore */ }
                    var better = wantMax ? t > bestT + 1e-9 : t < bestT - 1e-9;
                    var tie = Math.Abs(t - bestT) < 1e-9 && area > bestArea;
                    if (best is null || better || tie)
                    {
                        bestT = t;
                        bestArea = area;
                        best = face;
                    }
                }
            }
        }
        catch
        {
            return false;
        }

        if (best is null) return false;
        try
        {
            var corr = comp.GetCorresponding(best);
            var ok = corr is IEntity ent && ent.Select4(append, selData);
            if (ok)
            {
                var name = (axis == 0 ? "x" : axis == 1 ? "y" : "z") + (wantMax ? "max" : "min");
                Step("selectFace", true, $"{key} {name} t={bestT * 1000:0.02} mm");
            }

            return ok;
        }
        catch
        {
            return false;
        }
    }

    private Component2? FindComponent(IAssemblyDoc assy, string key)
    {
        if (string.IsNullOrWhiteSpace(key)) return null;
        foreach (var needle in ComponentNeedles(key))
        {
            if (_created.TryGetValue(needle, out var mapped) && !string.IsNullOrWhiteSpace(mapped))
            {
                key = mapped;
                break;
            }
        }

        if (AsArray(assy.GetComponents(false)) is not object[] comps) return null;
        var needles = ComponentNeedles(key).ToArray();
        foreach (var obj in comps)
        {
            if (obj is not Component2 c) continue;
            var name = c.Name2 ?? "";
            var path = "";
            try { path = c.GetPathName() ?? ""; } catch { /* ignore */ }
            foreach (var needle in needles)
            {
                if (string.IsNullOrWhiteSpace(needle)) continue;
                if (name.Equals(needle, StringComparison.OrdinalIgnoreCase) ||
                    name.StartsWith(needle + "-", StringComparison.OrdinalIgnoreCase) ||
                    name.StartsWith(needle + "/", StringComparison.OrdinalIgnoreCase) ||
                    Path.GetFileNameWithoutExtension(path).Equals(needle, StringComparison.OrdinalIgnoreCase) ||
                    Path.GetFileName(path).Equals(needle, StringComparison.OrdinalIgnoreCase))
                {
                    return c;
                }
            }
        }

        return null;
    }

    private static IEnumerable<string> ComponentNeedles(string key)
    {
        var raw = key.Trim();
        yield return raw;
        var norm = raw.Replace('\\', '/');
        yield return norm;
        yield return Path.GetFileName(norm);
        yield return Path.GetFileNameWithoutExtension(norm);
        var slash = norm.LastIndexOf('/');
        if (slash >= 0 && slash < norm.Length - 1)
        {
            yield return norm[(slash + 1)..];
            yield return Path.GetFileNameWithoutExtension(norm[(slash + 1)..]);
        }
    }

    private static string[] PlaneAliases(string plane) =>
        plane.ToLowerInvariant() switch
        {
            "front" or "frontale" => ["Front Plane", "Piano frontale", "Piano Frontale", "Front"],
            "right" or "destro" or "side" or "laterale" => ["Right Plane", "Piano destro", "Piano Destro", "Right"],
            "origin" or "origine" => ["Origine", "Origin", "OriginProfileFeature"],
            _ => ["Top Plane", "Piano superiore", "Piano Superiore", "Top"],
        };

    private void DoStandardViews(ModelDoc2 model, CadOperation op)
    {
        if (model is not IDrawingDoc drawing)
        {
            Step("Create1stAngleViews2", false, "Il documento non è una tavola");
            return;
        }

        var modelPath = SwPaths.Resolve(op.Str("model"));
        if (string.IsNullOrWhiteSpace(modelPath) || !File.Exists(modelPath))
        {
            Step("Create1stAngleViews2", false, $"Modello non trovato: {modelPath}");
            return;
        }

        modelPath = Path.GetFullPath(modelPath);
        if (_sw is not null)
        {
            var oErr = 0;
            var oWarn = 0;
            var dtype = modelPath.EndsWith(".sldasm", StringComparison.OrdinalIgnoreCase)
                ? (int)swDocumentTypes_e.swDocASSEMBLY
                : (int)swDocumentTypes_e.swDocPART;
            try
            {
                _sw.OpenDoc6(modelPath, dtype, (int)swOpenDocOptions_e.swOpenDocOptions_Silent, "", ref oErr, ref oWarn);
            }
            catch { /* may already be open */ }
            try
            {
                if (_sw.GetOpenDocumentByName(modelPath) is ModelDoc2 src)
                    ExitOpenSketchesAndRebuild(src);
            }
            catch { /* ignore */ }
            try
            {
                var aErr = 0;
                _sw.ActivateDoc3(model.GetTitle(), false, 0, ref aErr);
            }
            catch { /* ignore */ }
        }

        try
        {
            var sheet = drawing.GetCurrentSheet() as ISheet;
            var sheetName = sheet?.GetName();
            if (!string.IsNullOrWhiteSpace(sheetName))
                drawing.ActivateSheet(sheetName);
        }
        catch { /* Foglio1 / Sheet1 */ }

        var includeIso = op.Flag("includeIso", true);
        try
        {
            var ok = drawing.Create1stAngleViews2(modelPath);
            if (!ok) ok = drawing.Create3rdAngleViews2(modelPath);
            if (!ok)
            {
                ok = drawing.CreateDrawViewFromModelView3(modelPath, "*Front", 0.12, 0.18, 0) is not null
                     || drawing.CreateDrawViewFromModelView3(modelPath, "*Anteriore", 0.12, 0.18, 0) is not null;
                drawing.CreateDrawViewFromModelView3(modelPath, "*Top", 0.12, 0.08, 0);
                drawing.CreateDrawViewFromModelView3(modelPath, "*Superiore", 0.12, 0.08, 0);
                drawing.CreateDrawViewFromModelView3(modelPath, "*Right", 0.24, 0.18, 0);
                drawing.CreateDrawViewFromModelView3(modelPath, "*Destra", 0.24, 0.18, 0);
            }

            Step("Create1stAngleViews2", ok, Path.GetFileName(modelPath));
        }
        catch (Exception ex)
        {
            Step("Create1stAngleViews2", false, FormatEx(ex));
            try
            {
                drawing.CreateDrawViewFromModelView3(modelPath, "*Anteriore", 0.12, 0.18, 0);
                drawing.CreateDrawViewFromModelView3(modelPath, "*Superiore", 0.12, 0.08, 0);
                drawing.CreateDrawViewFromModelView3(modelPath, "*Destra", 0.24, 0.18, 0);
                Step("CreateDrawViewFromModelView", true, "fallback Anteriore/Superiore/Destra");
            }
            catch (Exception ex2)
            {
                Step("CreateDrawViewFromModelView", false, FormatEx(ex2));
            }
        }

        if (includeIso)
        {
            InsertIsoDrawingView(drawing, model, modelPath);
        }

        LogDrawingViews(drawing);
    }

    /// <summary>
    /// Vista iso da orientamento reale del modello (NameView / *Isometrica).
    /// *Isometric inglese su template IT restituisce null.
    /// </summary>
    private void InsertIsoDrawingView(IDrawingDoc drawing, ModelDoc2 drawingModel, string modelPath)
    {
        var named = EnsureIsoNamedView(modelPath);
        ActivateModel(drawingModel);
        try
        {
            var sheet = drawing.GetCurrentSheet() as ISheet;
            var sheetName = sheet?.GetName();
            if (!string.IsNullOrWhiteSpace(sheetName))
                drawing.ActivateSheet(sheetName);
        }
        catch { /* ignore */ }

        IView? iso = null;
        var used = "";
        var names = new[] { named, "SWIA_Iso", "*Isometrica", "*Current", "*Isometric", "*Trimetrica", "*Isometrico" };
        var locs = new (double X, double Y)[] { (0.355, 0.215), (0.30, 0.185), (0.28, 0.20), (0.33, 0.14) };
        foreach (var (x, y) in locs)
        {
            foreach (var name in names)
            {
                if (string.IsNullOrWhiteSpace(name)) continue;
                try
                {
                    iso = drawing.CreateDrawViewFromModelView3(modelPath, name, x, y, 0) as IView;
                }
                catch
                {
                    iso = null;
                }

                if (iso is not null)
                {
                    used = $"{name} @ {x:0.00},{y:0.00}";
                    TuneIsoView(iso);
                    goto IsoDone;
                }
            }
        }

        iso = TryDropIsoFromPalette(drawing, modelPath, 0.355, 0.215);
        if (iso is not null)
        {
            used = "palette DropDrawingViewFromPalette2";
            TuneIsoView(iso);
        }

        IsoDone:
        Step("CreateDrawViewFromModelView", iso is not null, iso is not null ? $"iso {used}" : "iso assente");
    }

    private static void TuneIsoView(IView iso)
    {
        try { ((dynamic)iso).ScaleDecimal = 0.08; } catch { /* scala foglio */ }
        try { ((dynamic)iso).Name = "Isometrica"; } catch { /* ignore */ }
    }

    private IView? TryDropIsoFromPalette(IDrawingDoc drawing, string modelPath, double x, double y)
    {
        try { drawing.GenerateViewPaletteViews(modelPath); }
        catch { return null; }

        foreach (var name in new[] { "Isometrica", "*Isometrica", "SWIA_Iso", "Isometric", "Trimetrica", "*Trimetrica" })
        {
            try
            {
                if (drawing.DropDrawingViewFromPalette2(name, x, y, 0) is IView v)
                    return v;
            }
            catch { /* next name */ }
        }

        return null;
    }

    private string EnsureIsoNamedView(string modelPath)
    {
        const string named = "SWIA_Iso";
        if (_sw is null) return "*Isometrica";
        try
        {
            var oErr = 0;
            var oWarn = 0;
            var dtype = modelPath.EndsWith(".sldasm", StringComparison.OrdinalIgnoreCase)
                ? (int)swDocumentTypes_e.swDocASSEMBLY
                : (int)swDocumentTypes_e.swDocPART;
            var mdl = _sw.OpenDoc6(modelPath, dtype, (int)swOpenDocOptions_e.swOpenDocOptions_Silent, "", ref oErr, ref oWarn) as ModelDoc2;
            if (mdl is null) return "*Isometrica";
            var aErr = 0;
            try { _sw.ActivateDoc3(mdl.GetTitle(), false, 0, ref aErr); } catch { /* ignore */ }
            ApplyStandardView(mdl, "*Isometric");
            try { mdl.NameView(named); } catch { /* già esiste */ }
            try { mdl.ViewZoomtofit2(); } catch { /* ignore */ }
            try { Thread.Sleep(500); } catch { /* ignore */ }
            Step("NameView", true, named);
            return named;
        }
        catch (Exception ex)
        {
            Step("NameView", false, FormatEx(ex));
            return "*Isometrica";
        }
    }

    private void ActivateModel(ModelDoc2 model)
    {
        if (_sw is null) return;
        try
        {
            var aErr = 0;
            _sw.ActivateDoc3(model.GetTitle(), false, 0, ref aErr);
        }
        catch
        {
            try { _sw.ActivateDoc(model.GetTitle()); } catch { /* ignore */ }
        }
    }

    private void LogDrawingViews(IDrawingDoc drawing)
    {
        var names = new List<string>();
        try
        {
            var v = drawing.GetFirstView() as IView;
            v = v?.GetNextView() as IView;
            while (v is not null)
            {
                var n = "";
                try { n = v.Name ?? ""; } catch { n = "?"; }
                names.Add(n);
                try { v = v.GetNextView() as IView; }
                catch { break; }
            }
        }
        catch (Exception ex)
        {
            Step("DrawingViews", false, FormatEx(ex));
            return;
        }

        var hasIso = names.Exists(n =>
            n.Contains("iso", StringComparison.OrdinalIgnoreCase)
            || n.Contains("SWIA", StringComparison.OrdinalIgnoreCase)
            || n.Contains("trime", StringComparison.OrdinalIgnoreCase));
        Step("DrawingViews", names.Count >= 4 || hasIso, $"{names.Count} viste: {string.Join(", ", names)}");
    }

    private void DoModelDimensions(ModelDoc2 model, CadOperation op)
    {
        if (model is not IDrawingDoc drawing)
        {
            Step("InsertModelAnnotations3", false, "Il documento non è una tavola");
            return;
        }

        var types = (int)swInsertAnnotation_e.swInsertDimensions
                    | (int)swInsertAnnotation_e.swInsertDimensionsMarkedForDrawing
                    | (int)swInsertAnnotation_e.swInsertNotes;
        try
        {
            drawing.InsertModelAnnotations3(1, types, true, true, false, true);
            Step("InsertModelAnnotations3", true, "quote/note modello");
        }
        catch (Exception ex)
        {
            try
            {
                drawing.InsertModelDimensions(0);
                Step("InsertModelDimensions", true, "fallback");
            }
            catch
            {
                Step("InsertModelAnnotations3", false, FormatEx(ex));
            }
        }
    }

    private void DoDrawingView(ModelDoc2 model, CadOperation op)
    {
        if (model is not IDrawingDoc drawing)
        {
            Step("CreateDrawViewFromModelView", false, "Il documento non è una tavola");
            return;
        }

        var view = op.Str("view", "*Isometric");
        if (!view.StartsWith('*')) view = "*" + view;
        var x = op.Num("x", 0.15);
        var y = op.Num("y", 0.15);
        if (x > 2) x = ToMeters(x, "mm");
        if (y > 2) y = ToMeters(y, "mm");
        var modelPath = SwPaths.Resolve(op.Str("model"));
        if (string.IsNullOrWhiteSpace(modelPath) || !File.Exists(modelPath))
        {
            Step("CreateDrawViewFromModelView", false, "Percorso modello mancante");
            return;
        }

        modelPath = Path.GetFullPath(modelPath);
        try
        {
            var v = drawing.CreateDrawViewFromModelView3(modelPath, view, x, y, 0) as IView;
            if (v is not null && op.Num("scale", 0) > 0)
            {
                try { ((dynamic)v).ScaleDecimal = op.Num("scale"); } catch { /* ignore */ }
            }
            Step("CreateDrawViewFromModelView", v is not null, $"{view} {Path.GetFileName(modelPath)}");
        }
        catch (Exception ex)
        {
            Step("CreateDrawViewFromModelView", false, FormatEx(ex));
        }
    }

    private void DoAnnotation(ModelDoc2 model, CadOperation op)
    {
        var text = op.Str("text");
        var x = op.Num("x", 0.01);
        var y = op.Num("y", 0.01);
        if (x > 2) x = ToMeters(x, "mm");
        if (y > 2) y = ToMeters(y, "mm");
        try
        {
            var note = model.InsertNote(text) as Note;
            try
            {
                var ann = note?.GetAnnotation() as Annotation;
                ann?.SetPosition2(x, y, 0);
            }
            catch { /* ignore */ }
            Step("InsertNote", note is not null, text);
        }
        catch (Exception ex)
        {
            Step("InsertNote", false, FormatEx(ex));
        }
    }

    private string? SaveIfRequested(ModelDoc2 model, DocumentSpec spec)
    {
        if (string.IsNullOrWhiteSpace(spec.SavePath)) return null;
        var path = Path.GetFullPath(spec.SavePath);
        var dir = Path.GetDirectoryName(path);
        if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);

        ActivateModel(model);
        try { Thread.Sleep(700); } catch { /* ignore */ }

        string currentPath;
        try { currentPath = model.GetPathName() ?? ""; }
        catch { currentPath = ""; }

        if (!string.IsNullOrWhiteSpace(currentPath)
            && string.Equals(Path.GetFullPath(currentPath), path, StringComparison.OrdinalIgnoreCase))
        {
            return SaveInPlace(model, path);
        }

        CloseForeignDocAtPath(path, model);
        TryDeleteExistingSaveTarget(path);

        for (var attempt = 1; attempt <= 3; attempt++)
        {
            try
            {
                ActivateModel(model);
                if (TrySaveAsOverwrite(model, path, out var errors, out var warnings)
                    && File.Exists(path))
                {
                    Step("SaveAs", true, $"{path} errors={errors} warnings={warnings}");
                    return path;
                }

                Step("SaveAs", false, $"{path} tentativo {attempt} errors={errors} warnings={warnings} exists={File.Exists(path)}");
            }
            catch (Exception ex)
            {
                var detail = FormatEx(ex);
                Step("SaveAs", false, $"tentativo {attempt}: {detail}");
                if (IsRpcDisconnected(detail))
                {
                    if (attempt == 3) throw;
                    try { Thread.Sleep(1200 * attempt); } catch { /* ignore */ }
                    try
                    {
                        if (_sw?.ActiveDoc is ModelDoc2 live) model = live;
                    }
                    catch { /* ignore */ }
                    continue;
                }

                return null;
            }

            try { Thread.Sleep(800 * attempt); } catch { /* ignore */ }
        }

        return null;
    }

    private string? SaveInPlace(ModelDoc2 model, string path)
    {
        try
        {
            var errors = 0;
            var warnings = 0;
            var ok = model.Save3((int)swSaveAsOptions_e.swSaveAsOptions_Silent, ref errors, ref warnings);
            var exists = File.Exists(path);
            Step("Save3", ok && exists, $"{path} errors={errors} warnings={warnings} exists={exists}");
            return ok && exists ? path : null;
        }
        catch (Exception ex)
        {
            var detail = FormatEx(ex);
            Step("Save3", false, detail);
            if (IsRpcDisconnected(detail)) throw;
            return null;
        }
    }

    private static bool TrySaveAsOverwrite(ModelDoc2 model, string path, out int errors, out int warnings)
    {
        errors = 0;
        warnings = 0;
        var opts = (int)swSaveAsOptions_e.swSaveAsOptions_Silent;
        try
        {
            var ext = (IModelDocExtension)model.Extension;
            if (ext.SaveAs(path, (int)swSaveAsVersion_e.swSaveAsCurrentVersion, opts, null, ref errors, ref warnings))
                return true;
        }
        catch
        {
            /* SaveAs4 */
        }

        errors = 0;
        warnings = 0;
        try
        {
            if (model.SaveAs4(
                    path,
                    (int)swSaveAsVersion_e.swSaveAsCurrentVersion,
                    opts,
                    ref errors,
                    ref warnings))
            {
                return true;
            }
        }
        catch
        {
            /* SaveAs */
        }

        try { return model.SaveAs(path); }
        catch { return false; }
    }

    private static bool IsRpcDisconnected(string detail) =>
        detail.Contains("80010108", StringComparison.OrdinalIgnoreCase)
        || detail.Contains("RPC_E_DISCONNECTED", StringComparison.OrdinalIgnoreCase);

    private void TryDeleteExistingSaveTarget(string path)
    {
        try
        {
            if (!File.Exists(path)) return;
            File.SetAttributes(path, FileAttributes.Normal);
            File.Delete(path);
            Console.WriteLine($"[{DateTime.Now:HH:mm:ss}] OK Unlink — {Path.GetFileName(path)}");
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[{DateTime.Now:HH:mm:ss}] Unlink {Path.GetFileName(path)}: {ex.Message}");
        }
    }

    private void CloseForeignDocAtPath(string path, ModelDoc2? keep)
    {
        if (_sw is null || string.IsNullOrWhiteSpace(path)) return;
        try
        {
            if (_sw.GetOpenDocumentByName(path) is not ModelDoc2 other) return;
            string keepTitle = "";
            try { keepTitle = keep?.GetTitle() ?? ""; } catch { /* ignore */ }
            string otherTitle;
            try { otherTitle = other.GetTitle(); }
            catch { return; }

            if (!string.IsNullOrWhiteSpace(keepTitle)
                && otherTitle.Equals(keepTitle, StringComparison.OrdinalIgnoreCase))
            {
                return;
            }

            ExitOpenSketchesAndRebuild(other);
            _sw.CloseDoc(otherTitle);
            try { Thread.Sleep(500); } catch { /* ignore */ }
            Step("CloseDoc", true, $"liberato {Path.GetFileName(path)}");
        }
        catch
        {
            /* destinazione non aperta */
        }
    }

    private string? SnapshotIfRequested(ModelDoc2 model, DocumentSpec spec)
    {
        if (string.IsNullOrWhiteSpace(spec.SnapshotPath)) return null;
        try
        {
            if (_sw is not null) ExitOpenSketchesOnAllDocuments(_sw);
            else ExitOpenSketchesAndRebuild(model);
            var dest = Path.GetFullPath(spec.SnapshotPath);
            var dir = Path.GetDirectoryName(dest);
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
            try { model.ViewZoomtofit2(); } catch { /* ignore */ }
            var named = string.IsNullOrWhiteSpace(spec.SnapshotView) ? "*Isometric" : spec.SnapshotView;
            if (!named.StartsWith('*')) named = "*" + named;
            var isDrawing = false;
            try { isDrawing = model.GetType() == (int)swDocumentTypes_e.swDocDRAWING; } catch { /* ignore */ }
            try
            {
                if (!isDrawing)
                    ApplyStandardView(model, named);
                else if (model is IDrawingDoc drawing && drawing.GetCurrentSheet() is Sheet sh)
                    sh.SheetFormatVisible = true;
            }
            catch { /* drawings / named view */ }

            try { model.GraphicsRedraw2(); } catch { /* ignore */ }
            if (isDrawing)
            {
                ActivateModel(model);
                try { Thread.Sleep(600); } catch { /* ignore */ }
                if (SwWindowCapture.TryCaptureJpeg(dest, out var capDetail))
                {
                    Step("CaptureWindow", true, capDetail);
                    return dest;
                }

                Step("CaptureWindow", false, capDetail);
            }

            var bmp = Path.ChangeExtension(dest, ".bmp");
            var ok = model.SaveBMP(bmp, 1400, 1000);
            if (!ok)
            {
                Step("SaveBMP", false, dest);
                return null;
            }

            if (dest.EndsWith(".bmp", StringComparison.OrdinalIgnoreCase))
            {
                Step("SaveBMP", true, dest);
                return dest;
            }

            using (var img = System.Drawing.Image.FromFile(bmp))
            {
                img.Save(dest, System.Drawing.Imaging.ImageFormat.Jpeg);
            }

            try { File.Delete(bmp); } catch { /* keep bmp if locked */ }
            Step("SaveBMP", true, dest);
            return dest;
        }
        catch (Exception ex)
        {
            Step("SaveBMP", false, FormatEx(ex));
            return null;
        }
    }

    private int _sketchStillIndex;

    private void CaptureQuotedSketch(ModelDoc2 model)
    {
        if (string.IsNullOrWhiteSpace(_sketchStillPath)) return;

        EnableVisibleDimensions(model);
        RevealAllDisplayDimensions(model);
        try { model.ViewZoomtofit2(); } catch { /* ignore */ }
        try { model.GraphicsRedraw2(); } catch { /* ignore */ }
        Thread.Sleep(450);

        _sketchStillIndex++;
        var dest = Path.ChangeExtension(Path.GetFullPath(_sketchStillPath), null)
                   + (_sketchStillIndex <= 1 ? "-schizzo.jpg" : $"-schizzo-{_sketchStillIndex}.jpg");
        if (SaveJpegFromView(model, dest, 1600, 1200))
        {
            _quotedStillSaved = true;
            Step("SaveBMP", true, dest + " (schizzo quotato)");
        }
    }

    private void SnapshotQuotedSketch(ModelDoc2 model, DocumentSpec spec)
    {
        if (_quotedStillSaved) return;
        if (model.GetType() != (int)swDocumentTypes_e.swDocPART) return;
        var dest = spec.SnapshotPath;
        if (string.IsNullOrWhiteSpace(dest)) return;
        dest = Path.ChangeExtension(Path.GetFullPath(dest), null) + "-schizzo.jpg";
        Feature? sketchFeat = null;
        try
        {
            var feat = (Feature)model.FirstFeature();
            while (feat is not null)
            {
                string tn;
                try { tn = feat.GetTypeName2(); }
                catch { tn = ""; }
                if (tn is "ProfileFeature")
                {
                    sketchFeat = feat;
                    break;
                }

                feat = feat.GetNextFeature() as Feature;
            }
        }
        catch
        {
            return;
        }

        if (sketchFeat is null) return;
        try
        {
            try { model.ShowFeatureDimensions(); } catch { /* ignore */ }
            model.ClearSelection2(true);
            try { model.ViewZoomtofit2(); } catch { /* ignore */ }
            try { model.GraphicsRedraw2(); } catch { /* ignore */ }
            Thread.Sleep(450);
            if (SaveJpegFromView(model, dest, 1600, 1200))
            {
                _quotedStillSaved = true;
                Step("SaveBMP", true, dest);
            }
            else
            {
                Step("SaveBMP", false, "schizzo: BMP non creato");
            }
        }
        catch (Exception ex)
        {
            Step("SaveBMP", false, "schizzo: " + FormatEx(ex));
        }
        finally
        {
            ExitOpenSketchesAndRebuild(model, forceRebuild: false);
            try { model.ClearSelection2(true); } catch { /* ignore */ }
            try { model.ViewDisplayShaded(); } catch { /* restore */ }
        }
    }

    private bool SaveJpegFromView(ModelDoc2 model, string dest, int w, int h)
    {
        try
        {
            var dir = Path.GetDirectoryName(dest);
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
            var bmp = Path.ChangeExtension(dest, ".bmp");
            var ok = false;
            try { ok = model.SaveBMP(bmp, w, h); } catch { /* ignore */ }
            if (!ok || !File.Exists(bmp)) return false;

            using (var img = System.Drawing.Image.FromFile(bmp))
            {
                img.Save(dest, System.Drawing.Imaging.ImageFormat.Jpeg);
            }

            try { File.Delete(bmp); } catch { /* keep bmp if locked */ }
            return File.Exists(dest);
        }
        catch (Exception ex)
        {
            Step("SaveBMP", false, FormatEx(ex));
            return false;
        }
    }

    private void CloseAfterExecute(ISldWorks swApp, ModelDoc2 model)
    {
        int type;
        string title;
        try { type = model.GetType(); }
        catch { return; }
        try { title = model.GetTitle(); }
        catch { title = ""; }

        if (type == (int)swDocumentTypes_e.swDocASSEMBLY
            || type == (int)swDocumentTypes_e.swDocDRAWING)
        {
            // Lascia assieme e tavola aperti: niente CloseDoc extra, GUI viva.
            return;
        }

        if (string.IsNullOrWhiteSpace(title)) return;
        try
        {
            ExitOpenSketchesAndRebuild(model);
            swApp.CloseDoc(title);
            Step("CloseDoc", true, title);
        }
        catch (Exception ex)
        {
            Step("CloseDoc", false, FormatEx(ex));
        }
    }

    private void CloseIdleDocuments(ISldWorks swApp, bool keepAssemblies, string? keepTitle = null)
    {
        object[]? docs;
        try { docs = AsArray(swApp.GetDocuments()); }
        catch { return; }
        if (docs is null) return;

        var closed = 0;
        foreach (var obj in docs)
        {
            if (obj is not ModelDoc2 d) continue;
            string t;
            int ty;
            try { t = d.GetTitle(); ty = d.GetType(); }
            catch { continue; }

            if (!string.IsNullOrWhiteSpace(keepTitle) &&
                t.Equals(keepTitle, StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            // NewDrawing: tieni gli assiemi aperti, servono per le viste.
            if (keepAssemblies && string.IsNullOrWhiteSpace(keepTitle)
                && ty == (int)swDocumentTypes_e.swDocASSEMBLY)
            {
                continue;
            }

            try
            {
                ExitOpenSketchesAndRebuild(d);
                swApp.CloseDoc(t);
                closed++;
            }
            catch
            {
                /* skip locked */
            }
        }

        if (closed > 0) Step("CloseDoc", true, $"chiusi {closed} documenti extra");
        if (!string.IsNullOrWhiteSpace(keepTitle))
        {
            try
            {
                var aErr = 0;
                swApp.ActivateDoc3(keepTitle, false, 0, ref aErr);
            }
            catch { /* ignore */ }
        }
    }

    private void ApplyStandardView(ModelDoc2 model, string named)
    {
        var viewId = StandardViewId(named);
        // ViewId -1 ignores English names on Italian templates (*Anteriore / *Superiore).
        try { model.ShowNamedView2("", viewId); } catch { /* ignore */ }
        foreach (var alias in ViewNameAliases(named))
        {
            try { model.ShowNamedView2(alias, viewId); } catch { /* ignore */ }
        }

        try { model.ViewZoomtofit2(); } catch { /* ignore */ }
        try { model.GraphicsRedraw2(); } catch { /* ignore */ }
        try { Thread.Sleep(250); } catch { /* ignore */ }
        Step("ShowNamedView2", true, $"{named} viewId={viewId}");
    }

    private static int StandardViewId(string named)
    {
        var key = named.Trim().TrimStart('*').ToLowerInvariant();
        return key switch
        {
            "front" or "anteriore" or "frontale" => (int)swStandardViews_e.swFrontView,
            "back" or "posteriore" => (int)swStandardViews_e.swBackView,
            "left" or "sinistra" => (int)swStandardViews_e.swLeftView,
            "right" or "destra" => (int)swStandardViews_e.swRightView,
            "top" or "superiore" or "sopra" => (int)swStandardViews_e.swTopView,
            "bottom" or "inferiore" or "sotto" => (int)swStandardViews_e.swBottomView,
            "trimetric" or "trimetrica" => (int)swStandardViews_e.swTrimetricView,
            "dimetric" or "dimetrica" => (int)swStandardViews_e.swDimetricView,
            _ => (int)swStandardViews_e.swIsometricView,
        };
    }

    private static string[] ViewNameAliases(string named)
    {
        var key = named.Trim().TrimStart('*').ToLowerInvariant();
        return key switch
        {
            "front" or "anteriore" or "frontale" => ["*Front", "*Anteriore"],
            "back" or "posteriore" => ["*Back", "*Posteriore"],
            "left" or "sinistra" => ["*Left", "*Sinistra"],
            "right" or "destra" => ["*Right", "*Destra"],
            "top" or "superiore" or "sopra" => ["*Top", "*Superiore"],
            "bottom" or "inferiore" or "sotto" => ["*Bottom", "*Inferiore"],
            "trimetric" or "trimetrica" => ["*Trimetric", "*Trimetrica"],
            "dimetric" or "dimetrica" => ["*Dimetric", "*Dimetrica"],
            _ => ["*Isometric", "*Isometrica"],
        };
    }

    private bool SelectPlane(ModelDoc2 model, string plane)
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
            var all = FeatureTreeReader.Read(model).Where(f => f.TypeName == "RefPlane").ToList();
            var wanted = plane.ToLowerInvariant();
            var match = all.FirstOrDefault(f =>
                f.Name.Contains(wanted, StringComparison.OrdinalIgnoreCase) ||
                aliases.Any(a => f.Name.Equals(a, StringComparison.OrdinalIgnoreCase)));
            if (match is not null)
            {
                feat = (Feature)model.FeatureByPositionReverse(match.Index);
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
                    feat = (Feature)model.FeatureByPositionReverse(pick.Index);
                }
            }
        }

        return feat is not null && feat.Select2(false, 0);
    }

    private static bool SelectFeature(ModelDoc2 model, string name)
    {
        var feat = FeatureTreeReader.FindByName(model, name);
        return feat is not null && feat.Select2(false, 0);
    }

    private static int SelectThicknessEdges(ModelDoc2 model)
    {
        try
        {
            if (model is not IPartDoc part) return 0;
            var bodies = AsArray(part.GetBodies2((int)swBodyType_e.swSolidBody, true));
            if (bodies is null) return 0;
            var n = 0;
            var first = true;
            foreach (var bObj in bodies)
            {
                if (bObj is not Body2 body) continue;
                var thickM = ThicknessFromBox(AsDoubles(body.GetBodyBox()));
                var edges = AsArray(body.GetEdges());
                if (edges is null) continue;
                foreach (var edgeObj in edges)
                {
                    var len = EdgeLengthMeters(edgeObj);
                    if (len <= 0 || Math.Abs(len - thickM) > 0.0015) continue;
                    if (edgeObj is IEntity ent)
                    {
                        ent.Select4(!first, null);
                        first = false;
                        n++;
                    }
                }
            }

            return n;
        }
        catch
        {
            return 0;
        }
    }

    private static double ThicknessFromBox(double[]? box)
    {
        if (box is not { Length: >= 6 }) return 0.008;
        var extents = new[]
        {
            Math.Abs(box[1] - box[0]),
            Math.Abs(box[3] - box[2]),
            Math.Abs(box[5] - box[4]),
            Math.Abs(box[3] - box[0]),
            Math.Abs(box[4] - box[1]),
            Math.Abs(box[5] - box[2]),
        };
        var thick = extents.Where(v => v > 0.001 && v < 0.025).DefaultIfEmpty(0.008).Min();
        return thick;
    }

    private static double EdgeLengthMeters(object edgeObj)
    {
        try
        {
            if (edgeObj is not IEdge edge) return 0;
            var p1 = AsDoubles((edge.GetStartVertex() as IVertex)?.GetPoint());
            var p2 = AsDoubles((edge.GetEndVertex() as IVertex)?.GetPoint());
            if (p1 is not { Length: >= 3 } || p2 is not { Length: >= 3 }) return 0;
            var dx = p1[0] - p2[0];
            var dy = p1[1] - p2[1];
            var dz = p1[2] - p2[2];
            return Math.Sqrt(dx * dx + dy * dy + dz * dz);
        }
        catch
        {
            return 0;
        }
    }

    private static void SelectAllBodyEdges(ModelDoc2 model)
    {
        try
        {
            if (model is not IPartDoc part) return;
            var bodies = AsArray(part.GetBodies2((int)swBodyType_e.swSolidBody, true));
            if (bodies is null) return;
            var first = true;
            foreach (Body2 body in bodies)
            {
                var edges = AsArray(body.GetEdges());
                if (edges is null) continue;
                foreach (var edgeObj in edges)
                {
                    if (edgeObj is IEntity ent)
                    {
                        ent.Select4(!first, null);
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

    private void RememberLatest(ModelDoc2 model, string id, string? name)
    {
        try
        {
            var feat = (Feature)model.FeatureByPositionReverse(0);
            RememberFeature(id, name, feat);
        }
        catch
        {
            if (!string.IsNullOrEmpty(id)) _created[id] = name ?? id;
        }
    }

    private void RememberFeature(string id, string? name, Feature? feat)
    {
        if (feat is null) return;
        var featName = feat.Name;
        if (!string.IsNullOrEmpty(id)) _created[id] = featName;
        if (!string.IsNullOrEmpty(name)) _created[name] = featName;
    }

    private static object[]? AsArray(object? raw)
    {
        if (raw is null) return null;
        if (raw is object[] oa) return oa;
        if (raw is Array a)
        {
            var list = new List<object>(a.Length);
            foreach (var x in a)
            {
                if (x is not null) list.Add(x);
            }

            return [.. list];
        }

        return null;
    }

    private static double Len(JsonElement c, string name, string units)
    {
        if (!c.TryGetProperty(name, out var el) || el.ValueKind != JsonValueKind.Number) return 0;
        return ToMeters(el.GetDouble(), units);
    }

    private static double ToMeters(double value, string units) =>
        units.Equals("m", StringComparison.OrdinalIgnoreCase) ? value : value / 1000.0;

    private void Step(string op, bool ok, string detail)
    {
        _steps.Add(new ExecStep { Op = op, Ok = ok, Detail = detail });
        Console.WriteLine($"[{DateTime.Now:HH:mm:ss}] {(ok ? "OK" : "FAIL")} {op} — {detail}");
    }

    internal static string FormatEx(Exception ex)
    {
        if (ex is COMException com) return $"COM 0x{com.ErrorCode:X8}: {com.Message}";
        if (ex.InnerException is COMException inner) return $"COM 0x{inner.ErrorCode:X8}: {inner.Message}";
        return $"{ex.GetType().Name}: {ex.Message}";
    }
}
