using System.Runtime.InteropServices;
using SolidWorks.Interop.sldworks;

namespace SolidWorksBridge;

internal sealed class SolidWorksSession
{
    private static readonly string[] ProgIds =
    [
        "SldWorks.Application",
        "SldWorks.Application.33",
        "SldWorks.Application.32",
        "SldWorks.Application.31",
        "SldWorks.Application.30",
    ];

    private ISldWorks? _app;
    private string? _attachPath;

    public BridgeResponse Status()
    {
        try
        {
            EnsureApp();
            string? version = null;
            string? title = null;
            int? type = null;
            try { version = _app!.RevisionNumber(); } catch { /* ignore */ }
            try
            {
                if (_app!.ActiveDoc is ModelDoc2 doc)
                {
                    try { title = doc.GetTitle(); } catch { /* ignore */ }
                    try { type = doc.GetType(); } catch { /* ignore */ }
                }
            }
            catch
            {
                /* no active doc */
            }

            return new BridgeResponse
            {
                Ok = true,
                AttachPath = _attachPath,
                Version = version,
                Document = title,
                DocumentType = type,
            };
        }
        catch (Exception ex)
        {
            return new BridgeResponse
            {
                Ok = false,
                Error = PayloadExecutor.FormatEx(ex),
                AttachPath = _attachPath,
            };
        }
    }

    public BridgeResponse Execute(SolidWorksDocumentPayload payload)
    {
        try
        {
            EnsureApp();
            var executor = new PayloadExecutor();
            var result = executor.Execute(_app!, payload);
            var steps = result.Steps;
            var features = result.Features;
            var failed = steps.Exists(s => !s.Ok &&
                !s.Op.Contains("Fillet", StringComparison.OrdinalIgnoreCase) &&
                !s.Op.Contains("InsertShell", StringComparison.OrdinalIgnoreCase) &&
                !s.Op.Contains("Chamfer", StringComparison.OrdinalIgnoreCase));
            return new BridgeResponse
            {
                Ok = !failed || features.Count > 0,
                AttachPath = _attachPath,
                Version = SafeVersion(),
                Document = result.DocTitle,
                DocumentType = result.DocType,
                SavedPath = result.SavedPath,
                SnapshotPath = result.SnapshotPath,
                Steps = steps,
                Features = features,
                Error = failed ? steps.Find(s => !s.Ok &&
                    !s.Op.Contains("Fillet", StringComparison.OrdinalIgnoreCase) &&
                    !s.Op.Contains("InsertShell", StringComparison.OrdinalIgnoreCase) &&
                    !s.Op.Contains("Chamfer", StringComparison.OrdinalIgnoreCase))?.Detail : null,
            };
        }
        catch (Exception ex)
        {
            return new BridgeResponse
            {
                Ok = false,
                Error = PayloadExecutor.FormatEx(ex),
                AttachPath = _attachPath,
            };
        }
    }

    private string? SafeVersion()
    {
        try { return _app!.RevisionNumber(); }
        catch { return null; }
    }

    private void EnsureApp()
    {
        if (_app is not null)
        {
            try
            {
                _ = _app.RevisionNumber();
                return;
            }
            catch
            {
                _app = null;
            }
        }

        Exception? last = null;
        foreach (var progId in ProgIds)
        {
            try
            {
                _app = (ISldWorks)ComActive.Get(progId);
                _attachPath = $"GetObject({progId})";
                Console.WriteLine($"[{DateTime.Now:HH:mm:ss}] COM attach {_attachPath} SW {_app.RevisionNumber()}");
                return;
            }
            catch (Exception ex)
            {
                last = ex;
                Console.WriteLine($"[{DateTime.Now:HH:mm:ss}] GetObject({progId}) fail: {PayloadExecutor.FormatEx(ex)}");
            }
        }

        foreach (var progId in ProgIds)
        {
            try
            {
                var t = Type.GetTypeFromProgID(progId, throwOnError: false);
                if (t is null)
                {
                    continue;
                }

                _app = (ISldWorks)Activator.CreateInstance(t)!;
                _attachPath = $"CreateObject({progId})";
                Console.WriteLine($"[{DateTime.Now:HH:mm:ss}] COM create {_attachPath}");
                return;
            }
            catch (Exception ex)
            {
                last = ex;
                Console.WriteLine($"[{DateTime.Now:HH:mm:ss}] CreateObject({progId}) fail: {PayloadExecutor.FormatEx(ex)}");
            }
        }

        throw last ?? new COMException(
            "Impossibile attaccare SldWorks.Application (GetObject/CreateObject).",
            unchecked((int)0x800401E3));
    }
}
