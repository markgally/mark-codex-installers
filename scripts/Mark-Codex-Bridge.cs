using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

internal static class MarkCodexBridge
{
    private static readonly Encoding Utf8 = new UTF8Encoding(false);

    private static int Main(string[] args)
    {
        try
        {
            string executable = ResolveCodexExecutable();
            if (executable == null)
                throw new IOException("The configured Codex CLI executable is missing.");

            var options = new ProcessStartInfo(executable, string.Join(" ", args.Select(QuoteArgument)))
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                StandardOutputEncoding = Utf8,
            };
            using (var child = Process.Start(options))
            using (var input = new StreamReader(Console.OpenStandardInput(), Utf8))
            using (var output = new StreamWriter(Console.OpenStandardOutput(), Utf8) { AutoFlush = true })
            using (var server = new StreamWriter(child.StandardInput.BaseStream, Utf8) { AutoFlush = true })
            {
                if (args.Length > 0 && args[0] == "app-server")
                    RelayAppServer(child.StandardOutput, input, output, server);
                else
                {
                    Task.Run(() => CopyInput(input, server));
                    child.StandardOutput.BaseStream.CopyTo(output.BaseStream);
                }
                child.WaitForExit();
                return child.ExitCode;
            }
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("MARK Codex bridge: " + error.Message);
            return 1;
        }
    }

    private static void RelayAppServer(StreamReader responses, TextReader input, TextWriter output, StreamWriter server)
    {
        var threadRequests = new ConcurrentDictionary<string, string>();
        var journalRequests = new Dictionary<string, Tuple<string, object>>();
        var inputLock = new object();
        Task.Run(() =>
        {
            var json = CreateSerializer();
            bool markClient = false;
            try
            {
                string line;
                while ((line = input.ReadLine()) != null)
                {
                    var packet = Parse(json, line);
                    var method = Value(packet, "method") as string;
                    var parameters = ObjectValue(packet, "params");
                    if (method == "initialize")
                        markClient = (Value(ObjectValue(parameters, "clientInfo"), "name") as string) == "jarvis-codex";
                    if (markClient && (method == "thread/resume" ||
                        (method == "thread/start" && !Equals(Value(parameters, "ephemeral"), true))))
                        threadRequests.TryAdd(RequestId(json, packet), method);
                    lock (inputLock)
                        server.WriteLine(line);
                }
            }
            catch (IOException) { }
            finally
            {
                lock (inputLock)
                    server.Close();
            }
        });

        var responseJson = CreateSerializer();
        string response;
        while ((response = responses.ReadLine()) != null)
        {
            var packet = Parse(responseJson, response);
            var id = RequestId(responseJson, packet);
            Tuple<string, object> threadResponse;
            if (journalRequests.TryGetValue(id, out threadResponse))
            {
                journalRequests.Remove(id);
                if (Value(packet, "error") != null)
                {
                    output.WriteLine(responseJson.Serialize(new
                    {
                        id = threadResponse.Item2,
                        error = new { code = -32603, message = "Codex could not initialize the new conversation journal." },
                    }));
                }
                else
                    output.WriteLine(threadResponse.Item1);
                continue;
            }

            string method;
            if (threadRequests.TryRemove(id, out method))
            {
                var thread = ObjectValue(ObjectValue(packet, "result"), "thread");
                var threadId = Value(thread, "id") as string;
                var journal = Value(thread, "path") as string;
                string normalized = NormalizeJournalPath(journal);
                if (normalized != journal)
                {
                    // MARK 0.2.7 compares the path with the spelling in its checkpoint.
                    thread["path"] = normalized;
                    response = responseJson.Serialize(packet);
                }
                if (method == "thread/start" && !string.IsNullOrEmpty(threadId) &&
                    !string.IsNullOrEmpty(normalized) && !File.Exists(normalized))
                {
                    // Let Codex persist its own journal before MARK opens it.
                    string journalId = "mark-journal-" + Guid.NewGuid().ToString("N");
                    var request = new
                    {
                        id = journalId,
                        method = "thread/inject_items",
                        @params = new
                        {
                            threadId,
                            items = new[] { new
                            {
                                type = "message",
                                role = "developer",
                                content = new[] { new { type = "input_text", text = "MARK initialized this conversation for text and voice." } },
                            } },
                        },
                    };
                    journalRequests.Add(responseJson.Serialize(journalId), Tuple.Create(response, Value(packet, "id")));
                    lock (inputLock)
                        server.WriteLine(responseJson.Serialize(request));
                    continue;
                }
            }
            output.WriteLine(response);
        }
    }

    private static string ResolveCodexExecutable()
    {
        string settings = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "mark-codex-cli.path");
        if (File.Exists(settings))
        {
            string configured = File.ReadAllText(settings).Trim();
            if (Path.IsPathRooted(configured) && File.Exists(configured))
                return configured;
        }
        // A copied folder keeps this PC's Codex path in the settings file.
        // Use the Codex runtime beside the bridge when that path is absent.
        string bundled = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "codex.exe");
        return File.Exists(bundled) ? bundled : null;
    }

    private static string NormalizeJournalPath(string path)
    {
        if (path == null || !path.StartsWith(@"\\?\", StringComparison.Ordinal))
            return path;

        string unprefixed = path.Substring(4);
        if (unprefixed.StartsWith(@"UNC\", StringComparison.OrdinalIgnoreCase))
            return @"\\" + unprefixed.Substring(4);
        if (unprefixed.Length >= 3 && unprefixed[1] == ':' && unprefixed[2] == '\\')
            return unprefixed;
        return path;
    }

    private static void CopyInput(TextReader input, StreamWriter output)
    {
        try
        {
            var buffer = new char[4096];
            int read;
            while ((read = input.Read(buffer, 0, buffer.Length)) != 0)
                output.Write(buffer, 0, read);
        }
        catch (IOException) { }
        finally { output.Close(); }
    }

    private static JavaScriptSerializer CreateSerializer()
    {
        return new JavaScriptSerializer { MaxJsonLength = int.MaxValue, RecursionLimit = 256 };
    }

    private static Dictionary<string, object> Parse(JavaScriptSerializer json, string text)
    {
        try { return json.DeserializeObject(text) as Dictionary<string, object>; }
        catch (ArgumentException) { return null; }
        catch (InvalidOperationException) { return null; }
    }

    private static object Value(Dictionary<string, object> dictionary, string name)
    {
        object value;
        return dictionary != null && dictionary.TryGetValue(name, out value) ? value : null;
    }

    private static Dictionary<string, object> ObjectValue(Dictionary<string, object> dictionary, string name)
    {
        return Value(dictionary, name) as Dictionary<string, object>;
    }

    private static string RequestId(JavaScriptSerializer json, Dictionary<string, object> message)
    {
        return json.Serialize(Value(message, "id"));
    }

    private static string QuoteArgument(string argument)
    {
        var quoted = new StringBuilder("\"");
        int backslashes = 0;
        foreach (char ch in argument)
        {
            if (ch == '\\')
            {
                backslashes++;
                continue;
            }
            quoted.Append('\\', ch == '"' ? 2 * backslashes + 1 : backslashes).Append(ch);
            backslashes = 0;
        }
        return quoted.Append('\\', 2 * backslashes).Append('"').ToString();
    }
}
