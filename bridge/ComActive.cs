using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;
using SolidWorks.Interop.sldworks;

namespace SolidWorksBridge;

internal static class ComActive
{
    private const uint ObjIdNativeOm = 0xFFFFFFF0;
    private static readonly Guid IDispatchId = new("00020400-0000-0000-C000-000000000046");

    [DllImport("ole32.dll", CharSet = CharSet.Unicode)]
    private static extern int CLSIDFromProgID(string lpszProgID, out Guid pclsid);

    [DllImport("oleaut32.dll", PreserveSig = true)]
    private static extern int GetActiveObject(ref Guid rclsid, IntPtr pvReserved,
        [MarshalAs(UnmanagedType.IUnknown)] out object ppunk);

    [DllImport("oleacc.dll")]
    private static extern int AccessibleObjectFromWindow(
        IntPtr hwnd,
        uint dwObjectID,
        ref Guid riid,
        [MarshalAs(UnmanagedType.IUnknown)] out object ppvUnknown);

    [DllImport("oleacc.dll", EntryPoint = "AccessibleObjectFromWindow")]
    private static extern int AccessibleObjectFromWindowDispatch(
        IntPtr hwnd,
        uint dwObjectID,
        byte[] riid,
        [MarshalAs(UnmanagedType.IDispatch)] out object ppvDispatch);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumChildWindows(IntPtr hWndParent, EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("ole32.dll")]
    private static extern int GetRunningObjectTable(int reserved, out IRunningObjectTable pprot);

    [DllImport("ole32.dll")]
    private static extern int CreateBindCtx(int reserved, out IBindCtx ppbc);

    public static ISldWorks? FromRot(out string detail)
    {
        var names = new List<string>();
        try
        {
            var hr = GetRunningObjectTable(0, out var rot);
            if (hr < 0)
            {
                detail = $"GetRunningObjectTable 0x{hr:X8}";
                return null;
            }

            rot.EnumRunning(out var enumerator);
            var monikers = new IMoniker[1];
            CreateBindCtx(0, out var ctx);
            while (enumerator.Next(1, monikers, IntPtr.Zero) == 0)
            {
                monikers[0].GetDisplayName(ctx, null, out var name);
                names.Add(name);
                if (name.Contains("SldWorks", StringComparison.OrdinalIgnoreCase) ||
                    name.Contains("SolidWorks", StringComparison.OrdinalIgnoreCase))
                {
                    rot.GetObject(monikers[0], out var obj);
                    var sw = CoerceSldWorks(obj);
                    if (sw is not null)
                    {
                        detail = name;
                        return sw;
                    }
                }
            }
        }
        catch (Exception ex)
        {
            detail = ex.Message;
            return null;
        }

        detail = names.Count == 0 ? "ROT vuota" : "ROT: " + string.Join(" | ", names.Take(20));
        return null;
    }

    public static object Get(string progId)
    {
        var hr = CLSIDFromProgID(progId, out var clsid);
        if (hr < 0)
        {
            Marshal.ThrowExceptionForHR(hr);
        }

        hr = GetActiveObject(ref clsid, IntPtr.Zero, out var obj);
        if (hr < 0)
        {
            Marshal.ThrowExceptionForHR(hr);
        }

        return obj;
    }

    public static ISldWorks? FromRunningWindow(out string detail)
    {
        var processes = Process.GetProcessesByName("SLDWORKS")
            .Where(p =>
            {
                try { return !p.HasExited; }
                catch { return false; }
            })
            .OrderByDescending(HasUi)
            .ToList();

        foreach (var proc in processes)
        {
            var handles = CollectWindows(proc.Id)
                .Where(h =>
                {
                    var cls = ClassName(h);
                    return !cls.Contains("tooltip", StringComparison.OrdinalIgnoreCase)
                           && !cls.Equals("Button", StringComparison.OrdinalIgnoreCase)
                           && !cls.Equals("ToolbarWindow32", StringComparison.OrdinalIgnoreCase);
                })
                .OrderBy(h => ClassName(h).StartsWith("Afx", StringComparison.OrdinalIgnoreCase) ? 0 : 1)
                .Take(25)
                .ToList();
            foreach (var hwnd in handles)
            {
                var app = FromHwnd(hwnd);
                if (app is not null)
                {
                    var title = SafeTitle(proc);
                    detail = $"HWND pid={proc.Id} title={title}";
                    return app;
                }
            }
        }

        detail = processes.Count == 0
            ? "nessun processo SLDWORKS"
            : $"HWND fallito su {processes.Count} processi";
        return null;
    }

    public static bool HasInteractiveSolidWorks() =>
        Process.GetProcessesByName("SLDWORKS").Any(HasUi);

    private static bool HasUi(Process proc)
    {
        try
        {
            if (proc.MainWindowHandle != IntPtr.Zero) return true;
            return !string.IsNullOrWhiteSpace(proc.MainWindowTitle);
        }
        catch
        {
            return false;
        }
    }

    private static string SafeTitle(Process proc)
    {
        try { return string.IsNullOrWhiteSpace(proc.MainWindowTitle) ? "(no title)" : proc.MainWindowTitle; }
        catch { return "(title error)"; }
    }

    private static List<IntPtr> CollectWindows(int pid)
    {
        var found = new List<IntPtr>();
        EnumWindows((hWnd, _) =>
        {
            GetWindowThreadProcessId(hWnd, out var windowPid);
            if (windowPid != (uint)pid) return true;
            found.Add(hWnd);
            EnumChildWindows(hWnd, (child, _) =>
            {
                found.Add(child);
                return true;
            }, IntPtr.Zero);
            return true;
        }, IntPtr.Zero);

        try
        {
            var main = Process.GetProcessById(pid).MainWindowHandle;
            if (main != IntPtr.Zero)
            {
                found.Remove(main);
                found.Insert(0, main);
            }
        }
        catch
        {
            /* process may have exited */
        }

        return found.Distinct().ToList();
    }

    private static ISldWorks? FromHwnd(IntPtr hwnd)
    {
        var iids = new[] { typeof(ISldWorks).GUID, IDispatchId };
        foreach (var iid in iids)
        {
            try
            {
                var guid = iid;
                var hr = AccessibleObjectFromWindow(hwnd, ObjIdNativeOm, ref guid, out var unk);
                if (hr >= 0 && unk is not null)
                {
                    var sw = CoerceSldWorks(unk);
                    if (sw is not null) return sw;
                    Console.WriteLine($"[{DateTime.Now:HH:mm:ss}] HWND 0x{hwnd.ToInt64():X} IUnknown type={unk.GetType().FullName}");
                }
                else if (ClassName(hwnd).StartsWith("Afx", StringComparison.OrdinalIgnoreCase))
                {
                    Console.WriteLine($"[{DateTime.Now:HH:mm:ss}] HWND 0x{hwnd.ToInt64():X} {ClassName(hwnd)} IUnknown hr=0x{hr:X8}");
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[{DateTime.Now:HH:mm:ss}] HWND IUnknown 0x{hwnd.ToInt64():X}: {ex.GetType().Name}");
            }

            try
            {
                var hr = AccessibleObjectFromWindowDispatch(hwnd, ObjIdNativeOm, iid.ToByteArray(), out var disp);
                if (hr >= 0 && disp is not null)
                {
                    var sw = CoerceSldWorks(disp);
                    if (sw is not null) return sw;
                    Console.WriteLine($"[{DateTime.Now:HH:mm:ss}] HWND 0x{hwnd.ToInt64():X} IDispatch type={disp.GetType().FullName}");
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[{DateTime.Now:HH:mm:ss}] HWND IDispatch 0x{hwnd.ToInt64():X}: {ex.GetType().Name}");
            }
        }

        return null;
    }

    private static ISldWorks? CoerceSldWorks(object obj)
    {
        if (obj is ISldWorks direct) return direct;
        try { return (ISldWorks)obj; }
        catch { /* next */ }

        try
        {
            var unk = Marshal.GetIUnknownForObject(obj);
            try
            {
                var typed = Marshal.GetTypedObjectForIUnknown(unk, typeof(ISldWorks));
                if (typed is ISldWorks sw) return sw;
            }
            finally
            {
                Marshal.Release(unk);
            }
        }
        catch { /* next */ }

        try
        {
            dynamic d = obj;
            _ = d.RevisionNumber;
            return (ISldWorks)d;
        }
        catch { /* not the app object */ }

        return null;
    }

    public static string DescribeWindows(int pid)
    {
        var parts = new List<string>();
        foreach (var hwnd in CollectWindows(pid).Take(40))
        {
            parts.Add($"0x{hwnd.ToInt64():X} {ClassName(hwnd)}");
        }

        return string.Join("; ", parts);
    }

    private static string ClassName(IntPtr hWnd)
    {
        var sb = new StringBuilder(256);
        _ = GetClassName(hWnd, sb, sb.Capacity);
        return sb.ToString();
    }
}

