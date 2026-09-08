using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
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
        Exception? last = null;
        for (var attempt = 1; attempt <= 2; attempt++)
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
                last = ex;
                var detail = PayloadExecutor.FormatEx(ex);
                if (attempt < 2 && IsDisconnected(detail))
                {
                    Console.WriteLine($"[{DateTime.Now:HH:mm:ss}] COM disconnected, retry {attempt + 1}/2: {detail}");
                    _app = null;
                    try { Thread.Sleep(1800); } catch { /* ignore */ }
                    continue;
                }

                return new BridgeResponse
                {
                    Ok = false,
                    Error = detail,
                    AttachPath = _attachPath,
                };
            }
        }

        return new BridgeResponse
        {
            Ok = false,
            Error = last is null ? "Esecuzione COM fallita" : PayloadExecutor.FormatEx(last),
            AttachPath = _attachPath,
        };
    }

    private static bool IsDisconnected(string detail) =>
        detail.Contains("80010108", StringComparison.OrdinalIgnoreCase)
        || detail.Contains("RPC_E_DISCONNECTED", StringComparison.OrdinalIgnoreCase);

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
                try { _app.Visible = true; } catch { /* ignore */ }
                return;
            }
            catch (Exception ex)
            {
                last = ex;
                Console.WriteLine($"[{DateTime.Now:HH:mm:ss}] GetObject({progId}) fail: {PayloadExecutor.FormatEx(ex)}");
            }
        }

        try
        {
            _app = ComActive.FromRot(out var rotDetail);
            if (_app is not null)
            {
                _attachPath = $"ROT({rotDetail})";
                Console.WriteLine($"[{DateTime.Now:HH:mm:ss}] COM attach {_attachPath} SW {_app.RevisionNumber()}");
                try { _app.Visible = true; } catch { /* ignore */ }
                return;
            }

            Console.WriteLine($"[{DateTime.Now:HH:mm:ss}] ROT attach fail: {rotDetail}");
        }
        catch (Exception ex)
        {
            last = ex;
            Console.WriteLine($"[{DateTime.Now:HH:mm:ss}] ROT attach fail: {PayloadExecutor.FormatEx(ex)}");
        }

        try
        {
            _app = ComActive.FromRunningWindow(out var hwndDetail);
            if (_app is not null)
            {
                _attachPath = $"HWND({hwndDetail})";
                Console.WriteLine($"[{DateTime.Now:HH:mm:ss}] COM attach {_attachPath} SW {_app.RevisionNumber()}");
                try { _app.Visible = true; } catch { /* ignore */ }
                return;
            }

            Console.WriteLine($"[{DateTime.Now:HH:mm:ss}] HWND attach fail: {hwndDetail}");
        }
        catch (Exception ex)
        {
            last = ex;
            Console.WriteLine($"[{DateTime.Now:HH:mm:ss}] HWND attach fail: {PayloadExecutor.FormatEx(ex)}");
        }

        if (ComActive.HasInteractiveSolidWorks())
        {
            Console.WriteLine($"[{DateTime.Now:HH:mm:ss}] GUI SolidWorks presente ma non in ROT/HWND; CreateObject (Visible=true)");
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
                try { _app.Visible = true; } catch { /* ignore */ }
                try { _app.UserControl = true; } catch { /* ignore */ }
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
