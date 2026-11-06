using System;
using System.IO;
using System.Net;
using System.Text;
using System.Web.Script.Serialization;
using System.Collections.Generic;
using System.Reflection;
class FakeNetwork {
  static string root = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
  static JavaScriptSerializer json = new JavaScriptSerializer();
  static string Read(string name) { return File.ReadAllText(Path.Combine(root, name + ".json")); }
  static string Mode(string name) { return (string)json.Deserialize<Dictionary<string, object>>(Read(name))["mode"]; }
  static int Main(string[] args) {
    string provider = Path.GetFileNameWithoutExtension(Assembly.GetExecutingAssembly().Location);
    File.AppendAllText(Path.Combine(root, "commands.jsonl"), json.Serialize(new { provider = provider, args = args }) + "\n");
    if (provider == "tailscale") {
      if (args[0] == "status") Console.WriteLine(Read("ts-status"));
      else if (args[0] == "serve" && args[1] == "status") Console.WriteLine(Read("ts-serve"));
      else if (args[0] == "serve") {
        if (args[args.Length-1] == "off") File.WriteAllText(Path.Combine(root, "ts-serve.json"), Read("ts-unrelated"));
        else if (Mode("ts-mode") == "authorize") { Console.Error.WriteLine("Enable HTTPS at https://login.tailscale.com/admin/dns"); return 1; }
        else if (Mode("ts-mode") == "fail") { Console.Error.WriteLine("fixture network unavailable"); return 1; }
        else File.WriteAllText(Path.Combine(root, "ts-serve.json"), Read("ts-after"));
      } else return 1;
      return 0;
    }
    string metrics = args[Array.IndexOf(args, "--metrics") + 1];
    HttpListener listener = new HttpListener();
    listener.Prefixes.Add("http://" + metrics + "/"); listener.Start();
    while (true) {
      HttpListenerContext context = listener.GetContext();
      bool ready = Mode("cf-mode") == "ready";
      context.Response.StatusCode = ready ? 200 : 503;
      context.Response.ContentType = "application/json";
      byte[] content = Encoding.UTF8.GetBytes(ready ? "{\"ready\":true}" : "{\"ready\":false}");
      context.Response.OutputStream.Write(content, 0, content.Length); context.Response.Close();
    }
  }
}
