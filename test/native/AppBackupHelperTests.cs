using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Pipes;
using System.Reflection;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Web.Script.Serialization;

internal static class HelperTests {
    static int checks;
    static object Call(string method, params object[] args) {return typeof(Program).GetMethod(method,BindingFlags.Static|BindingFlags.NonPublic).Invoke(null,args);}
    static void Expect(bool value) {checks++;if(!value)throw new Exception("Assertion "+checks+" failed");}
    static void Refused(Action action) {bool failed=false;try{action();}catch(TargetInvocationException){failed=true;}Expect(failed);}
    static Dictionary<string,object> Request(long age=300,string tenant="11111111-1111-1111-1111-111111111111",string scope="DeviceManagementApps.ReadWrite.All") {
        var claims=new {tid=tenant,scp=scope,iat=DateTimeOffset.UtcNow.ToUnixTimeSeconds()-age};
        var encoded=Convert.ToBase64String(Encoding.UTF8.GetBytes(new JavaScriptSerializer().Serialize(claims))).TrimEnd('=').Replace('+','-').Replace('/','_');
        return new Dictionary<string,object>{{"tenantId","11111111-1111-1111-1111-111111111111"},{"accessToken","header."+encoded+".signature"}};
    }
    static int Main() {
        try {
            Expect(Environment.OSVersion.Version.Major >= 10);
            Expect(!Signature.Valid(System.Diagnostics.Process.GetCurrentProcess().MainModule.FileName));
            Expect((string)Call("CommittedVersion",new Dictionary<string,object>{{"committedContentVersion","1"}})=="1");
            foreach(var version in new object[]{null,"",0,"0","01","invalid","123456789012345678901"}) {
                try {Call("CommittedVersion",new Dictionary<string,object>{{"committedContentVersion",version}});throw new Exception("Invalid content version accepted");}
                catch(TargetInvocationException e){Expect(e.InnerException.Message.Contains("no committed installer content"));}
            }
            // Claims is a refusal-only preflight. These synthetic tokens are never accepted
            // for capture: Capture independently requires Graph to authenticate the exact token.
            Expect(Call("Claims",Request())!=null);
            Expect(Call("Claims",Request(590))!=null);
            Refused(()=>Call("Claims",Request(601)));
            Refused(()=>Call("Claims",Request(-61)));
            Refused(()=>Call("Claims",Request(0,"22222222-2222-2222-2222-222222222222")));
            Refused(()=>Call("Claims",Request(0,scope:"DeviceManagementApps.Read.All")));
            using(var stream=new MemoryStream()) {
                Call("Write",stream,new {challenge="one-request"});stream.Position=0;
                Expect(((string)Call("Read",stream)).Contains("one-request"));
            }
            foreach(var length in new[]{-1,0,524289})using(var stream=new MemoryStream(BitConverter.GetBytes(length)))Refused(()=>Call("Read",stream));
            using(var truncated=new MemoryStream(new byte[]{5,0,0,0,65}))Refused(()=>Call("Read",truncated));
            var security=new PipeSecurity();security.AddAccessRule(new PipeAccessRule(WindowsIdentity.GetCurrent().User,PipeAccessRights.FullControl,AccessControlType.Allow));
            var name="TenuVault-Capture-"+Guid.NewGuid().ToString("N");
            using(var server=(NamedPipeServerStream)Call("Server",name,security)) {
                Refused(()=>Call("Server",name,security));
                using(var client=new NamedPipeClientStream(".",name,PipeDirection.InOut)) {
                    var waiting=server.BeginWaitForConnection(null,null);client.Connect(2000);server.EndWaitForConnection(waiting);
                    Call("Write",client,new {challenge="bound"});Expect(((string)Call("Read",server)).Contains("bound"));
                }
            }
            Console.WriteLine("Windows helper checks passed: "+checks);return 0;
        }catch(Exception error){Console.Error.WriteLine(error);return 1;}
    }
}
