// Single-request Windows enrollment helper. No installer bytes or plaintext files are written here.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Cryptography.Pkcs;
using System.Security.Cryptography.X509Certificates;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using System.Xml;
using Microsoft.Win32;
using Microsoft.Win32.SafeHandles;

internal static class Program {
    const int Limit = 512 * 1024;
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = Limit, RecursionLimit = 24 };
    static readonly string Image = Process.GetCurrentProcess().MainModule.FileName;
    static Timer Deadline, ParentWatch;
    static FileStream ImageLock, ParentImageLock;
    static volatile bool Cancelled, WaitingForApproval;
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetNamedPipeClientProcessId(IntPtr pipe, out uint pid);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetNamedPipeServerProcessId(IntPtr pipe, out uint pid);
    [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr handle, int kind, ref ProcessInfo info, int size, out int returned);
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr reserved1, peb, reserved2, reserved3, pid, parent; }
    [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes { public int length; public IntPtr descriptor; public bool inherit; }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern SafePipeHandle CreateNamedPipe(string name,uint openMode,uint mode,uint instances,uint outSize,uint inSize,uint timeout,ref SecurityAttributes attributes);
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool QueryFullProcessImageName(IntPtr process,uint flags,StringBuilder name,ref uint size);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    static string ProcessImage(int pid) {
        var handle=OpenProcess(0x1000,false,pid);if(handle==IntPtr.Zero)throw new Exception("Process unavailable.");
        try {var name=new StringBuilder(32768);uint size=32768;if(!QueryFullProcessImageName(handle,0,name,ref size))throw new Exception();return name.ToString();}finally{CloseHandle(handle);}
    }
    static NamedPipeServerStream Server(string name,PipeSecurity security) {
        var bytes=security.GetSecurityDescriptorBinaryForm();var pin=GCHandle.Alloc(bytes,GCHandleType.Pinned);
        try {
            var attributes=new SecurityAttributes{length=Marshal.SizeOf(typeof(SecurityAttributes)),descriptor=pin.AddrOfPinnedObject()};
            var handle=CreateNamedPipe(@"\\.\pipe\"+name,3|0x40000000|0x00080000,0x8,1,65536,65536,0,ref attributes);
            if(handle.IsInvalid)throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            return new NamedPipeServerStream(PipeDirection.InOut,true,false,handle);
        } finally {pin.Free();}
    }
    static int Main(string[] args) {
        ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
        Deadline = new Timer(_ => Environment.Exit(3), null, args.Length > 0 && args[0] == "broker" ? 360000 : 120000, Timeout.Infinite);
        try {
            ImageLock = new FileStream(Image,FileMode.Open,FileAccess.Read,FileShare.Read);
            if (args.Length == 2 && args[0] == "broker") Broker(int.Parse(args[1]));
            else if (args.Length == 3 && args[0] == "worker") Worker(args[1], int.Parse(args[2]));
            else throw new Exception("Invalid helper invocation.");
            return 0;
        } catch (CaptureError e) { Console.WriteLine(Json.Serialize(new { error = e.Message })); return 1;
        } catch (System.ComponentModel.Win32Exception e) {
            Console.WriteLine(Json.Serialize(new { error = e.NativeErrorCode == 1223 ? "Windows approval was cancelled. No backup was created." : "The Windows capture helper could not start." })); return 1;
        } catch { Console.WriteLine(Json.Serialize(new { error = "The Windows capture helper failed. No backup was created." })); return 1; }
        finally { Deadline.Dispose(); if(ParentWatch!=null)ParentWatch.Dispose(); if(ParentImageLock!=null)ParentImageLock.Dispose(); if(ImageLock!=null)ImageLock.Dispose(); }
    }
    static Dictionary<string,object> Obj(object value) { var d=value as Dictionary<string,object>; if(d==null) throw new Exception("Invalid response."); return d; }
    static Dictionary<string,object> Parse(string text) { return Obj(Json.DeserializeObject(text)); }
    static string Str(Dictionary<string,object> d,string key,int max=16384) { object v; if(!d.TryGetValue(key,out v)||!(v is string)||((string)v).Length>max) throw new Exception("Missing field."); return (string)v; }
    static string GuidValue(Dictionary<string,object> d,string key) { return Guid.Parse(Str(d,key,36)).ToString(); }
    static object[] Rows(Dictionary<string,object> d,string key) { object v; if(!d.TryGetValue(key,out v)||!(v is object[])) throw new Exception("Invalid collection."); return (object[])v; }
    static string Random() { var b=new byte[32]; using(var r=RandomNumberGenerator.Create()) r.GetBytes(b); return Convert.ToBase64String(b); }
    static string Read(Stream stream) {
        var prefix=new byte[4]; Exact(stream,prefix); int n=BitConverter.ToInt32(prefix,0);
        if(n<2||n>Limit) throw new Exception("Invalid frame."); var bytes=new byte[n]; Exact(stream,bytes); return new UTF8Encoding(false,true).GetString(bytes);
    }
    static void Exact(Stream stream,byte[] b) { int p=0; while(p<b.Length) {int n=stream.Read(b,p,b.Length-p);if(n==0)throw new EndOfStreamException();p+=n;} }
    static void Write(Stream stream,object value) { var b=Encoding.UTF8.GetBytes(Json.Serialize(value));if(b.Length>Limit)throw new Exception();stream.Write(BitConverter.GetBytes(b.Length),0,4);stream.Write(b,0,b.Length);stream.Flush(); }
    static void Peer(int pid) {
        if(!String.Equals(ProcessImage(pid),Image,StringComparison.OrdinalIgnoreCase)) throw new Exception("Wrong peer.");
    }
    static void Broker(int parent) {
        var info=new ProcessInfo(); int returned;
        if(NtQueryInformationProcess(Process.GetCurrentProcess().Handle,0,ref info,Marshal.SizeOf(info),out returned)!=0||info.parent.ToInt64()!=parent) throw new Exception("Wrong parent.");
        // Both ends are the same helper image. Release builds additionally require the app and
        // helper to have the same valid Authenticode publisher (checked before elevation).
        var parentImage=ProcessImage(parent);
        ParentImageLock=new FileStream(parentImage,FileMode.Open,FileAccess.Read,FileShare.Read);
        VerifyPublisher(parentImage);
        var parentProcess=Process.GetProcessById(parent);
        ParentWatch=new Timer(_=>{try{if(parentProcess.HasExited)Environment.Exit(4);}catch{Environment.Exit(4);}},null,500,500);
        var request=Parse(Read(Console.OpenStandardInput()));
        Claims(request); // Early refusals do not need a Windows elevation prompt.
        WaitingForApproval=true;
        var cancellation=new Thread(()=> {
            try { Console.OpenStandardInput().ReadByte(); } catch { }
            Cancelled=true;
            if(!WaitingForApproval)Environment.Exit(4);
        });
        cancellation.IsBackground=true;cancellation.Start();
        var name="TenuVault-Capture-"+Guid.NewGuid().ToString("N");
        var security=new PipeSecurity(); security.SetAccessRuleProtection(true,false);
        security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.NetworkSid,null),PipeAccessRights.FullControl,AccessControlType.Deny));
        security.AddAccessRule(new PipeAccessRule(WindowsIdentity.GetCurrent().User,PipeAccessRights.FullControl,AccessControlType.Allow));
        security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid,null),PipeAccessRights.FullControl,AccessControlType.Allow));
        using(var pipe=Server(name,security)) {
            // First-instance-only, local pipe. The peer PID must be the exact child launched below.
            using(var worker=Process.Start(new ProcessStartInfo(Image,"worker "+name+" "+Process.GetCurrentProcess().Id) { UseShellExecute=true,Verb="runas",WindowStyle=ProcessWindowStyle.Hidden })) {
                WaitingForApproval=false;
                if(Cancelled)throw new CaptureError("Source operation cancelled.");
                var wait=pipe.BeginWaitForConnection(null,null);
                if(!wait.AsyncWaitHandle.WaitOne(60000))throw new Exception("Approval timed out.");pipe.EndWaitForConnection(wait);
                uint pid;if(!GetNamedPipeClientProcessId(pipe.SafePipeHandle.DangerousGetHandle(),out pid)||pid!=worker.Id)throw new Exception("Wrong client.");Peer((int)pid);
                var hello=Parse(Read(pipe));request["challenge"]=Str(hello,"challenge",100);
                request["issuedAt"]=DateTimeOffset.UtcNow.ToUnixTimeSeconds();Write(pipe,request);
                // Killing the broker closes the pipe. The worker also monitors this exact process.
                Console.WriteLine(Read(pipe));
            }
        }
    }
    static void Worker(string name,int parent) {
        if(!Regex.IsMatch(name,@"^TenuVault-Capture-[a-f0-9]{32}$")||!new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator))throw new Exception();
        Peer(parent);
        using(var p=Process.GetProcessById(parent)) using(var monitor=new Timer(_=>{if(p.HasExited)Environment.Exit(4);},null,500,500))
        using(var pipe=new NamedPipeClientStream(".",name,PipeDirection.InOut,PipeOptions.None,TokenImpersonationLevel.Identification)) {
            pipe.Connect(15000);uint pid;if(!GetNamedPipeServerProcessId(pipe.SafePipeHandle.DangerousGetHandle(),out pid)||pid!=parent)throw new Exception();
            var challenge=Random();Write(pipe,new {challenge=challenge});var request=Parse(Read(pipe));
            if(Str(request,"challenge",100)!=challenge||Math.Abs(DateTimeOffset.UtcNow.ToUnixTimeSeconds()-Convert.ToInt64(request["issuedAt"]))>60)throw new Exception();
            object result;
            try { result=Capture(request); }
            catch(CaptureError e) { result=new {error=e.Message}; }
            catch { result=new {error="Intune capture failed while checking authorization or content. No backup was created."}; }
            Write(pipe,result); // One request only; no loop and no reusable session.
        }
    }
    sealed class CaptureError:Exception { public CaptureError(string text):base(text){} }
    static string CommittedVersion(Dictionary<string,object> row) {
        object value;
        if(!row.TryGetValue("committedContentVersion",out value)||!(value is string)||!Regex.IsMatch((string)value,@"^[1-9][0-9]{0,19}$"))
            throw new CaptureError("This app has no committed installer content in Intune. Choose an app with an uploaded installer.");
        return (string)value;
    }
    static Dictionary<string,object> Get(HttpClient client,string path) {
        using(var response=client.GetAsync("https://graph.microsoft.com/beta/"+path,HttpCompletionOption.ResponseHeadersRead).GetAwaiter().GetResult()) {
            if(response.StatusCode!=HttpStatusCode.OK)throw new CaptureError("Microsoft authorization or app metadata could not be confirmed (HTTP "+(int)response.StatusCode+"). Reconnect the tenant and retry.");
            return Parse(Bounded(response));
        }
    }
    static string Bounded(HttpResponseMessage response) {
        using(var stream=response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()) using(var output=new MemoryStream()) {
            var b=new byte[8192];int n;while((n=stream.Read(b,0,b.Length))>0){if(output.Length+n>Limit)throw new Exception("Response too large.");output.Write(b,0,n);}return new UTF8Encoding(false,true).GetString(output.ToArray());
        }
    }
    static Dictionary<string,object> Claims(Dictionary<string,object> request) {
        var tenant=GuidValue(request,"tenantId");var token=Str(request,"accessToken",32768);
        var pieces=token.Split('.');if(pieces.Length!=3)throw new CaptureError("Reconnect the tenant's Microsoft session.");
        var payload=pieces[1].Replace('-','+').Replace('_','/');payload=payload.PadRight((payload.Length+3)/4*4,'=');
        var claims=Parse(Encoding.UTF8.GetString(Convert.FromBase64String(payload)));
        if(GuidValue(claims,"tid")!=tenant)throw new CaptureError("The Microsoft session belongs to another tenant.");
        if(!claims.ContainsKey("scp")||!Str(claims,"scp").Split(' ').Contains("DeviceManagementApps.ReadWrite.All"))throw new CaptureError("The tenant's app registration needs delegated DeviceManagementApps.ReadWrite.All permission. Reconnect Microsoft after admin consent.");
        // Entra backdates issued-at by about five minutes for clock skew. The app forces
        // token refresh; this independent upper bound rejects old/replayed credentials.
        var age=DateTimeOffset.UtcNow.ToUnixTimeSeconds()-Convert.ToInt64(claims["iat"]);
        if(age>600||age< -60)throw new CaptureError("The Microsoft session is not recent enough for Backup. Reconnect Microsoft and check this PC's clock.");
        return claims; // Untrusted until Graph accepts this exact token in Capture().
    }
    static object Capture(Dictionary<string,object> request) {
        var tenant=GuidValue(request,"tenantId");var app=GuidValue(request,"appId");GuidValue(request,"jobId");
        var token=Str(request,"accessToken",32768);var claims=Claims(request);
        string version,account,appName;long expectedBytes;
        using(var graph=new HttpClient(new HttpClientHandler {AllowAutoRedirect=false}) {Timeout=TimeSpan.FromSeconds(20)}) {
            graph.DefaultRequestHeaders.Authorization=new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer",token);
            // Graph authenticates the token before any claims are trusted or private key is used.
            if(GuidValue(Get(graph,"me?$select=id"),"id")!=GuidValue(claims,"oid"))throw new CaptureError("The Microsoft requester could not be confirmed.");
            var roles=claims.ContainsKey("wids") ? Rows(claims,"wids").OfType<string>() : Enumerable.Empty<string>();
            if(!roles.Contains("62e90394-69f5-4237-9190-012177145e10")&&!roles.Contains("3a2c62db-5318-420d-8d74-23affee5d9d5"))throw new CaptureError("This preview requires an active Intune Administrator or Global Administrator role. Custom Intune roles are not supported yet.");
            account=GuidValue(Get(graph,"deviceManagement?$select=intuneAccountId"),"intuneAccountId");
            var row=Get(graph,"deviceAppManagement/mobileApps/"+app+"?$select=id,displayName,microsoft.graph.win32LobApp/committedContentVersion,microsoft.graph.win32LobApp/installExperience");
            if(Str(row,"@odata.type")!="#microsoft.graph.win32LobApp"||GuidValue(row,"id")!=app)throw new CaptureError("Select a Win32 app in this tenant.");
            if(Str(Obj(row["installExperience"]),"runAsAccount")!="system")throw new CaptureError("This preview supports apps installed in the system context only.");
            version=CommittedVersion(row);
            appName=Str(row,"displayName",300);
            var files=Get(graph,"deviceAppManagement/mobileApps/"+app+"/microsoft.graph.win32LobApp/contentVersions/"+version+"/files?$select=id,size,isCommitted,isDependency");
            var candidates=Rows(files,"value").Select(Obj).Where(f=>f.ContainsKey("isCommitted")&&f["isCommitted"] is bool&&(bool)f["isCommitted"]&&(!f.ContainsKey("isDependency")||f["isDependency"] is bool&&!(bool)f["isDependency"])).ToArray();
            if(files.ContainsKey("@odata.nextLink")||candidates.Length!=1)throw new CaptureError("The app's installer content is ambiguous. Refresh Intune and retry.");
            expectedBytes=Convert.ToInt64(candidates[0]["size"]);if(expectedBytes<22||expectedBytes>2147483648L)throw new CaptureError("Installer size is outside this preview's 2 GiB limit.");
        }
        using(var cert=Certificate(tenant,account)) {
            var endpoint=Endpoint();var session=Guid.NewGuid().ToString();var device=Guid.Parse(cert.GetNameInfo(X509NameType.SimpleName,false)).ToString();
            var ime=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86),@"Microsoft Intune Management Extension\Microsoft.Management.Services.IntuneWindowsAgent.AgentCommon.dll");
            var clientInfo=new {DeviceName=Environment.MachineName,OperatingSystemVersion=Environment.OSVersion.Version.ToString(),SideCarAgentVersion=FileVersionInfo.GetVersionInfo(ime).FileVersion,Win10SMode=false,ExtendedInventoryMap=new {}};
            var body=new {Key=session,SessionId=session,RequestContentType="GetContentInfo",ClientInfo=Json.Serialize(clientInfo),RequestPayload=Json.Serialize(new {ApplicationId=app,ApplicationVersion=version,ApplicationName=appName,Intent=3,CertificateBlob=Convert.ToBase64String(cert.RawData),TargetingMethod=0,TargetType=2,InstallContext=2,EspPhase=0,AssignmentFilterIds=new string[0],ManagedInstallerStatus=1,ApplicationEnforcement=0,AppTypeSpecificPropertiesFormat=0}),CheckinReason="OnDemand",CheckinReasonPayload=Json.Serialize(new {NotificationID=Guid.Empty.ToString(),NotificationIntent="",SyncType=""})};
            var handler=new HttpClientHandler {AllowAutoRedirect=false};handler.ClientCertificates.Add(cert);
            using(var client=new HttpClient(handler) {Timeout=TimeSpan.FromSeconds(45)}) {
                foreach(var h in new Dictionary<string,string>{{"AccountId",account},{"DeviceId",device},{"Prefer","return-content"},{"Scenario-Type","Windows-GetContentInfo"},{"client-request-id",session},{"Request-Attempt-Count","0"}}) client.DefaultRequestHeaders.TryAddWithoutValidation(h.Key,h.Value);
                using(var response=client.PutAsync(endpoint+"/SideCarGatewaySessions('"+session+"')?api-version=1.6",new StringContent(Json.Serialize(body),Encoding.UTF8,"application/json")).GetAwaiter().GetResult()) {
                    if(!response.IsSuccessStatusCode)throw new CaptureError(response.StatusCode==HttpStatusCode.Forbidden
                        ? "Intune did not allow this device to retrieve the installer (HTTP 403). Review the app's Required targeting for this device."
                        : "Intune could not process the installer content request (HTTP "+(int)response.StatusCode+"). Refresh the app and retry; changing assignments may not resolve this error.");
                    var result=Parse(Str(Parse(Bounded(response)),"ResponsePayload",Limit));
                    if(result.ContainsKey("ErrorCode")&&Convert.ToString(result["ErrorCode"])!="0"&&Convert.ToString(result["ErrorCode"])!="")throw new CaptureError("Intune returned a content error. No backup was created.");
                    if(GuidValue(result,"ApplicationId")!=app||Str(result,"ApplicationVersion",20)!=version)throw new CaptureError("Intune returned a different app version. Refresh and retry.");
                    var content=Parse(Str(result,"ContentInfo",Limit));long bytes=Convert.ToInt64(content["OriginalSize"]);if(bytes!=expectedBytes)throw new CaptureError("Intune returned a different installer size. Refresh and retry.");
                    var rawContentId=Str(content,"DoFileId",4096);if(String.IsNullOrWhiteSpace(rawContentId))throw new CaptureError("Intune returned no content identifier.");
                    string contentId;using(var hash=SHA256.Create())contentId="sha256:"+String.Concat(hash.ComputeHash(Encoding.UTF8.GetBytes(rawContentId)).Select(b=>b.ToString("x2")));var url=new Uri(Str(content,"UploadLocation"));
                    if(url.Scheme!="https"||!Regex.IsMatch(url.Host,@"(^|\.)manage\.microsoft\.com$")||!url.IsDefaultPort||url.UserInfo!=""||url.Fragment!="")throw new CaptureError("Intune returned an unsupported content address.");
                    var settings=new XmlReaderSettings {DtdProcessing=DtdProcessing.Prohibit,XmlResolver=null,MaxCharactersInDocument=Limit};var xml=new XmlDocument {XmlResolver=null};
                    using(var reader=XmlReader.Create(new StringReader(Str(result,"DecryptInfo",Limit)),settings))xml.Load(reader);
                    var nodes=xml.SelectNodes("//*[local-name()='EncryptedContent']");if(nodes.Count!=1)throw new Exception();var cms=new EnvelopedCms();cms.Decode(Convert.FromBase64String(nodes[0].InnerText));cms.Decrypt(new X509Certificate2Collection(cert));
                    var dec=Parse(Encoding.UTF8.GetString(cms.ContentInfo.Content));
                    return new {identity=new {tenantId=tenant,appId=app,appType="#microsoft.graph.win32LobApp",contentVersion=version,contentFileId=contentId},appName=appName,downloadUrl=url.AbsoluteUri,bytes=bytes,encryption=new {profileIdentifier=Str(dec,"ProfileIdentifier"),encryptionKey=Str(dec,"EncryptionKey"),initializationVector=Str(dec,"IV"),macKey=Str(dec,"MacKey"),mac=Str(dec,"Mac"),fileDigest=Str(dec,"UnencryptedFileDigest"),fileDigestAlgorithm=Str(dec,"UnencryptedFileDigestAlgorithm")}};
                }
            }
        }
    }
    static X509Certificate2 Certificate(string tenant,string account) {
        var thumbs=new List<string>();using(var root=Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Enrollments")) {
            if(root!=null)foreach(var key in root.GetSubKeyNames())using(var e=root.OpenSubKey(key)) {
                if(String.Equals(Convert.ToString(e.GetValue("AADTenantID")),tenant,StringComparison.OrdinalIgnoreCase))thumbs.Add(Convert.ToString(e.GetValue("DMPCertThumbPrint")).Replace(" ",""));
            }
        }
        using(var store=new X509Store(StoreName.My,StoreLocation.LocalMachine)) {
            store.Open(OpenFlags.ReadOnly);var matches=new List<X509Certificate2>();
            foreach(var c in store.Certificates) {
                if(!c.HasPrivateKey||c.NotBefore.ToUniversalTime()>DateTime.UtcNow||c.NotAfter.ToUniversalTime()<=DateTime.UtcNow||thumbs.Count(t=>String.Equals(t,c.Thumbprint,StringComparison.OrdinalIgnoreCase))!=1)continue;
                var ext=c.Extensions.Cast<X509Extension>().SingleOrDefault(e=>e.Oid.Value=="1.2.840.113556.5.6");if(ext==null)continue;var b=ext.RawData;if(b.Length==18&&b[0]==4&&b[1]==16)b=b.Skip(2).ToArray();if(b.Length==16&&new Guid(b).ToString()==account)matches.Add(c);
            }
            if(matches.Count!=1)throw new CaptureError("This PC needs exactly one current Intune enrollment for the selected tenant.");return matches[0];
        }
    }
    static string Endpoint() {
        // IME discovers its regional service. Read only recent, administrator-owned agent logs;
        // never accept an endpoint from the renderer, command line, or a user-selected file.
        var root=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),@"Microsoft\IntuneManagementExtension\Logs");
        var pattern=@"https://agents\.[a-z0-9-]+\.manage\.microsoft\.com/TrafficGateway/TrafficRoutingService/SideCar/StatelessSideCarGatewayService";
        if((File.GetAttributes(root)&FileAttributes.ReparsePoint)!=0)throw new CaptureError("The Intune agent log folder cannot be a link.");
        foreach(var path in Directory.GetFiles(root,"IntuneManagementExtension*.log").OrderByDescending(File.GetLastWriteTimeUtc).Take(3)) {
            if((File.GetAttributes(path)&FileAttributes.ReparsePoint)!=0)continue;
            if(File.GetLastWriteTimeUtc(path)<DateTime.UtcNow.AddDays(-7))continue;
            using(var f=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.ReadWrite|FileShare.Delete)) {
                f.Seek(Math.Max(0,f.Length-4*1024*1024),SeekOrigin.Begin);using(var r=new StreamReader(f)) {var m=Regex.Matches(r.ReadToEnd(),pattern,RegexOptions.IgnoreCase);if(m.Count>0)return m[m.Count-1].Value;}
            }
        }
        throw new CaptureError("The Intune agent's current service address could not be found. Sync this PC with Intune, then retry Backup.");
    }
    static void VerifyPublisher(string parent) {
#if REQUIRE_SIGNATURE
        // WinVerifyTrust validates chain, timestamp and Authenticode hash, not just the presence
        // of a certificate. The parent must share the helper's publisher.
        if(!Signature.Valid(Image)||!Signature.Valid(parent))throw new CaptureError("The app or capture helper has an invalid signature.");
        using(var own=new X509Certificate2(X509Certificate.CreateFromSignedFile(Image)))using(var other=new X509Certificate2(X509Certificate.CreateFromSignedFile(parent)))if(own.Subject!=other.Subject)throw new CaptureError("The capture helper publisher does not match TenuVault.");
#endif
    }
}
internal static class Signature {
    [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct FileInfo {public uint size;public string path;public IntPtr file,subject;}
    [StructLayout(LayoutKind.Sequential)] struct TrustData {public uint size;public IntPtr policy,sip;public uint ui,revocation,choice;public IntPtr file;public uint state;public IntPtr stateData,url;public uint flags,context;}
    [DllImport("wintrust.dll",CharSet=CharSet.Unicode)]static extern int WinVerifyTrust(IntPtr hwnd,ref Guid action,ref TrustData data);
    public static bool Valid(string path) {
        var info=new FileInfo{size=(uint)Marshal.SizeOf(typeof(FileInfo)),path=path};var p=Marshal.AllocHGlobal(Marshal.SizeOf(info));Marshal.StructureToPtr(info,p,false);
        var data=new TrustData{size=(uint)Marshal.SizeOf(typeof(TrustData)),ui=2,choice=1,file=p,state=1,flags=0x1000};var action=new Guid("00aac56b-cd44-11d0-8cc2-00c04fc295ee");
        try{return WinVerifyTrust(new IntPtr(-1),ref action,ref data)==0;}finally{data.state=2;WinVerifyTrust(new IntPtr(-1),ref action,ref data);Marshal.DestroyStructure(p,typeof(FileInfo));Marshal.FreeHGlobal(p);}
    }
}
