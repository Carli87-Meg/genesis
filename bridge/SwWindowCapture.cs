using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

namespace SolidWorksBridge;

internal static class SwWindowCapture
{
    private const int SwRestore = 9;

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr hWnd, out WinRect lpRect);

    [StructLayout(LayoutKind.Sequential)]
    private struct WinRect
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    public static bool TryCaptureJpeg(string dest, out string detail)
    {
        try
        {
            var proc = Process.GetProcessesByName("SLDWORKS")
                .FirstOrDefault(p => p.MainWindowHandle != IntPtr.Zero);
            if (proc is null)
            {
                detail = "nessuna finestra SLDWORKS";
                return false;
            }

            var hwnd = proc.MainWindowHandle;
            ShowWindow(hwnd, SwRestore);
            SetForegroundWindow(hwnd);
            Thread.Sleep(400);
            if (!GetWindowRect(hwnd, out var rect))
            {
                detail = "GetWindowRect fallita";
                return false;
            }

            var w = rect.Right - rect.Left;
            var h = rect.Bottom - rect.Top;
            if (w < 200 || h < 200)
            {
                detail = $"rect troppo piccolo {w}x{h}";
                return false;
            }

            var dir = Path.GetDirectoryName(dest);
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);

            using var bmp = new Bitmap(w, h);
            using (var g = Graphics.FromImage(bmp))
            {
                g.CopyFromScreen(rect.Left, rect.Top, 0, 0, new Size(w, h));
            }

            bmp.Save(dest, ImageFormat.Jpeg);
            detail = $"{dest} {w}x{h}";
            return File.Exists(dest) && new FileInfo(dest).Length > 2000;
        }
        catch (Exception ex)
        {
            detail = ex.GetType().Name + ": " + ex.Message;
            return false;
        }
    }
}
