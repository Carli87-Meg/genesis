using System.Runtime.InteropServices;

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

    private dynamic? _app;
    private string? _attachPath;

    public BridgeResponse Status()
    {
        try
        {
            EnsureApp();
            string? version = null;
            string? title = null;
            int? type = null;
            try { version = (string)_app!.RevisionNumber(); } catch { /* ignore */ }
            try
            {
                dynamic doc = _app!.ActiveDoc;
                if (doc is not null && doc is not DBNull)
                {
                    try { title = (string)doc.GetTitle(); } catch { /* ignore */ }
                    try { type = (int)doc.GetType(); } catch { /* ignore */ }
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
            var result = executor.Execute((object)_app!, payload);
            var steps = result.Steps;
            var features = result.Features;
            var title = result.DocTitle;
            var docType = result.DocType;
            var failed = steps.Exists(s => !s.Ok);
            return new BridgeResponse
            {
                Ok = !failed || features.Count > 0,
                AttachPath = _attachPath,
                Version = SafeVersion(),
                Document = title,
                DocumentType = docType,
                Steps = steps,
                Features = features,
                Error = failed ? steps.Find(s => !s.Ok)?.Detail : null,
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
        try { return (string)_app!.RevisionNumber(); }
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
                _app = ComActive.Get(progId);
                _attachPath = $"GetObject({progId})";
                Console.WriteLine($"[{DateTime.Now:HH:mm:ss}] COM attach {_attachPath}");
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

                _app = Activator.CreateInstance(t);
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
