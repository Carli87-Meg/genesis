using SolidWorksBridge;

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        var port = 47821;
        for (var i = 0; i < args.Length; i++)
        {
            if (args[i] is "--port" or "-p" && i + 1 < args.Length && int.TryParse(args[i + 1], out var p))
            {
                port = p;
            }
        }

        var envPort = Environment.GetEnvironmentVariable("SOLIDWORKS_BRIDGE_PORT");
        if (!string.IsNullOrWhiteSpace(envPort) && int.TryParse(envPort, out var ep))
        {
            port = ep;
        }

        var prefix = $"http://127.0.0.1:{port}/";
        Console.WriteLine("SolidWorksBridge HTTP→COM (STA, processo esterno, non add-in)");
        Console.WriteLine($"Listen {prefix}");
        Console.WriteLine("GET  /health  /status");
        Console.WriteLine("POST /execute  schemaVersion 2");

        using var sta = new StaDispatcher();
        var session = new SolidWorksSession();
        var server = new BridgeHttpServer(prefix, sta, session);

        try
        {
            server.Start();
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"HttpListener: {ex.Message}");
            return 1;
        }

        using var cts = new CancellationTokenSource();
        Console.CancelKeyPress += (_, e) =>
        {
            e.Cancel = true;
            cts.Cancel();
        };

        try
        {
            server.ListenAsync(cts.Token).GetAwaiter().GetResult();
        }
        catch (OperationCanceledException)
        {
            /* shutdown */
        }

        return 0;
    }
}
