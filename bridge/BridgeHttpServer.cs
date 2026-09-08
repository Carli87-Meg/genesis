using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace SolidWorksBridge;

internal sealed class BridgeHttpServer
{
    private readonly HttpListener _listener = new();
    private readonly StaDispatcher _sta;
    private readonly SolidWorksSession _session;
    private readonly JsonSerializerOptions _json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        WriteIndented = true,
    };

    public BridgeHttpServer(string prefix, StaDispatcher sta, SolidWorksSession session)
    {
        _sta = sta;
        _session = session;
        _listener.Prefixes.Add(prefix);
    }

    public void Start() => _listener.Start();

    public async Task ListenAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            HttpListenerContext ctx;
            try
            {
                ctx = await _listener.GetContextAsync().WaitAsync(ct);
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch (HttpListenerException)
            {
                break;
            }

            _ = Task.Run(() => Handle(ctx), ct);
        }
    }

    private void Handle(HttpListenerContext ctx)
    {
        var req = ctx.Request;
        var res = ctx.Response;
        try
        {
            AddCors(res);
            if (req.HttpMethod == "OPTIONS")
            {
                res.StatusCode = 204;
                res.Close();
                return;
            }

            var path = req.Url?.AbsolutePath.TrimEnd('/') ?? "";
            if (path.Length == 0)
            {
                path = "/";
            }

            if (req.HttpMethod == "GET" && (path is "/" or "/health"))
            {
                WriteJson(res, 200, new
                {
                    ok = true,
                    service = "SolidWorksBridge",
                    schemaVersion = 2,
                    architecture = "external-http-com",
                    sta = true,
                });
                return;
            }

            if (req.HttpMethod == "GET" && path == "/status")
            {
                var status = _sta.Invoke(() => _session.Status());
                WriteJson(res, status.Ok ? 200 : 503, status);
                return;
            }

            if (req.HttpMethod is "POST" or "GET" && path == "/cleanup")
            {
                string? keep = null;
                if (req.HttpMethod == "POST")
                {
                    using var reader = new StreamReader(req.InputStream, req.ContentEncoding);
                    var body = reader.ReadToEnd();
                    if (!string.IsNullOrWhiteSpace(body))
                    {
                        try
                        {
                            using var doc = JsonDocument.Parse(body);
                            if (doc.RootElement.TryGetProperty("keep", out var k))
                                keep = k.GetString();
                        }
                        catch { /* ignore */ }
                    }
                }
                else
                {
                    keep = req.QueryString["keep"];
                }

                var result = _sta.Invoke(() => _session.Cleanup(keep));
                WriteJson(res, result.Ok ? 200 : 500, result);
                return;
            }

            if (req.HttpMethod == "POST" && path is "/execute" or "/v2/execute")
            {
                using var reader = new StreamReader(req.InputStream, req.ContentEncoding);
                var body = reader.ReadToEnd();
                SolidWorksDocumentPayload payload;
                try
                {
                    payload = JsonSerializer.Deserialize<SolidWorksDocumentPayload>(body, _json)
                              ?? throw new InvalidOperationException("JSON vuoto");
                }
                catch (Exception ex)
                {
                    WriteJson(res, 400, new BridgeResponse { Ok = false, Error = $"JSON: {ex.Message}" });
                    return;
                }

                if (payload.SchemaVersion != 0 && payload.SchemaVersion != 2)
                {
                    WriteJson(res, 400, new BridgeResponse
                    {
                        Ok = false,
                        Error = $"schemaVersion {payload.SchemaVersion} non supportato (atteso 2)",
                    });
                    return;
                }

                payload.SchemaVersion = 2;
                var result = _sta.Invoke(() => _session.Execute(payload));
                WriteJson(res, result.Ok ? 200 : 500, result);
                return;
            }

            WriteJson(res, 404, new { ok = false, error = $"Not found: {req.HttpMethod} {path}" });
        }
        catch (Exception ex)
        {
            try
            {
                WriteJson(res, 500, new BridgeResponse { Ok = false, Error = PayloadExecutor.FormatEx(ex) });
            }
            catch
            {
                res.StatusCode = 500;
                res.Close();
            }
        }
    }

    private void WriteJson(HttpListenerResponse res, int status, object body)
    {
        var bytes = JsonSerializer.SerializeToUtf8Bytes(body, _json);
        res.StatusCode = status;
        res.ContentType = "application/json; charset=utf-8";
        res.ContentEncoding = Encoding.UTF8;
        res.ContentLength64 = bytes.Length;
        res.OutputStream.Write(bytes, 0, bytes.Length);
        res.Close();
    }

    private static void AddCors(HttpListenerResponse res)
    {
        res.Headers["Access-Control-Allow-Origin"] = "*";
        res.Headers["Access-Control-Allow-Methods"] = "GET,POST,OPTIONS";
        res.Headers["Access-Control-Allow-Headers"] = "Content-Type";
    }
}
