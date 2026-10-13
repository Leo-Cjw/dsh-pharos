using System;
using System.Net;
using System.Text;
using System.Text.RegularExpressions;
using System.Runtime.InteropServices;
using System.Threading;

[StructLayout(LayoutKind.Sequential)]
public struct PharosNotificationInput {
 [MarshalAs(UnmanagedType.LPWStr)] public string Key;
 [MarshalAs(UnmanagedType.LPWStr)] public string Value;
}
[ComImport,ComVisible(true),Guid("53E31837-6600-4A81-9395-75CFFE746F94"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IPharosNotificationCallback {
 void Activate([In,MarshalAs(UnmanagedType.LPWStr)] string appId,
  [In,MarshalAs(UnmanagedType.LPWStr)] string arguments,
  [In,MarshalAs(UnmanagedType.LPArray,SizeParamIndex=3)] PharosNotificationInput[] input,
  [In,MarshalAs(UnmanagedType.U4)] uint count);
}
[ComVisible(true),Guid("1D9DF316-599A-4CAB-8FF9-F0F012928FCA"),ClassInterface(ClassInterfaceType.None)]
public class PharosNotificationCallback : IPharosNotificationCallback {
 public void Activate(string appId,string arguments,PharosNotificationInput[] input,uint count) {
  try { if(appId==PharosNotificationActivation.AppId) PharosNotificationActivation.Deliver(arguments); }
  finally { PharosNotificationActivation.Completed.Set(); }
 }
}
[ComImport,ComVisible(true),Guid("00000001-0000-0000-C000-000000000046"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IPharosClassFactory {
 [PreserveSig] int CreateInstance(IntPtr outer,ref Guid iid,out IntPtr instance);
 [PreserveSig] int LockServer([MarshalAs(UnmanagedType.Bool)] bool locked);
}
[ComVisible(true),ClassInterface(ClassInterfaceType.None)]
public class PharosNotificationFactory : IPharosClassFactory {
 public int CreateInstance(IntPtr outer,ref Guid iid,out IntPtr instance) {
  instance=IntPtr.Zero;
  if(outer!=IntPtr.Zero)return unchecked((int)0x80040110);
  var callback=new PharosNotificationCallback();
  if(iid==typeof(PharosNotificationCallback).GUID) {
   instance=Marshal.GetComInterfaceForObject(callback,typeof(IPharosNotificationCallback));return 0;
  }
  var unknown=Marshal.GetIUnknownForObject(callback);
  try { return Marshal.QueryInterface(unknown,ref iid,out instance); }
  finally { Marshal.Release(unknown); }
 }
 public int LockServer(bool locked) { return 0; }
}
public static class PharosNotificationActivation {
 public const string AppId="LeoCjw.DshPharos";
 public static readonly ManualResetEventSlim Completed=new ManualResetEventSlim(false);
 private static readonly ManualResetEventSlim ListenerReady=new ManualResetEventSlim(false);
 private static readonly ManualResetEventSlim ListenerStop=new ManualResetEventSlim(false);
 private static Thread listener;
 private static int listenerResult=-1;
 [DllImport("ole32.dll")] private static extern int CoInitializeEx(IntPtr reserved,uint mode);
 [DllImport("ole32.dll")] private static extern void CoUninitialize();
 [DllImport("ole32.dll")] private static extern int CoRegisterClassObject(ref Guid clsid,[MarshalAs(UnmanagedType.IUnknown)] object factory,uint context,uint flags,out uint cookie);
 [DllImport("ole32.dll")] private static extern int CoRevokeClassObject(uint cookie);
 public static bool StartListener() {
  if(listener!=null)return listenerResult>=0;
  listener=new Thread(()=>{
   var initialized=CoInitializeEx(IntPtr.Zero,0);uint cookie=0;
   var factory=new PharosNotificationFactory();
   try {
    listenerResult=initialized;
    if(initialized>=0) {
     var clsid=typeof(PharosNotificationCallback).GUID;
     listenerResult=CoRegisterClassObject(ref clsid,factory,4,1,out cookie);
    }
    ListenerReady.Set();
    if(listenerResult>=0)ListenerStop.Wait();
   } finally {
    if(cookie!=0)CoRevokeClassObject(cookie);GC.KeepAlive(factory);
    if(initialized>=0)CoUninitialize();
   }
  });
  listener.IsBackground=true;listener.SetApartmentState(ApartmentState.MTA);listener.Start();
  return ListenerReady.Wait(5000)&&listenerResult>=0;
 }
 public static void StopListener() { ListenerStop.Set();if(listener!=null)listener.Join(1000); }
 public static bool Parse(string arguments,out int port,out string ticket) {
  port=0;ticket=null;if(arguments==null)return false;
  var match=Regex.Match(arguments,@"\A([0-9]{1,5})/([0-9a-f]{48})\z",RegexOptions.CultureInvariant);
  if(!match.Success||!Int32.TryParse(match.Groups[1].Value,out port)||port<1||port>65535)return false;
  ticket=match.Groups[2].Value;return true;
 }
 public static bool Deliver(string arguments) {
  int port;string ticket;if(!Parse(arguments,out port,out ticket))return false;
  try {
   var request=(HttpWebRequest)WebRequest.Create("http://127.0.0.1:"+port+"/pharos/api/native-activation");
   request.Proxy=null;request.AllowAutoRedirect=false;request.Timeout=5000;request.ReadWriteTimeout=5000;
   request.Method="POST";request.ContentType="application/json";request.Headers["x-pharos-desktop"]="1";
   request.ServicePoint.Expect100Continue=false;
   var body=Encoding.UTF8.GetBytes("{\"ticket\":\""+ticket+"\"}");request.ContentLength=body.Length;
   using(var stream=request.GetRequestStream())stream.Write(body,0,body.Length);
   using(var response=(HttpWebResponse)request.GetResponse())return response.StatusCode==HttpStatusCode.OK;
  } catch { return false; }
 }
 public static bool ValidServerArgs(string[] args) {
  return args!=null&&args.Length>=1&&args.Length<=2&&args[0]=="-ToastActivated"&&
   (args.Length==1||String.Equals(args[1],"-Embedding",StringComparison.OrdinalIgnoreCase));
 }
 [MTAThread] public static int Main(string[] args) {
  if(!ValidServerArgs(args))return 2;
  var initialized=CoInitializeEx(IntPtr.Zero,0);if(initialized<0)return 3;
  uint cookie=0;var factory=new PharosNotificationFactory();
  try {
   var clsid=typeof(PharosNotificationCallback).GUID;
   var result=CoRegisterClassObject(ref clsid,factory,4,1,out cookie);
   if(result<0)return 4;
   return Completed.Wait(30000)?0:5;
  } finally {
   if(cookie!=0)CoRevokeClassObject(cookie);GC.KeepAlive(factory);CoUninitialize();
  }
 }
}

[StructLayout(LayoutKind.Sequential)] public struct PharosShortcutKey { public Guid Format; public uint Id; public PharosShortcutKey(uint id) { Format=new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");Id=id; } }
[StructLayout(LayoutKind.Explicit,Size=24)] public struct PharosShortcutValue { [FieldOffset(0)] public ushort Type; [FieldOffset(8)] public IntPtr Pointer; }
[ComImport,Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] public interface IPharosShortcutStore {
 void GetCount(out uint count);void GetAt(uint index,out PharosShortcutKey key);void GetValue(ref PharosShortcutKey key,out PharosShortcutValue value);void SetValue(ref PharosShortcutKey key,ref PharosShortcutValue value);void Commit();
}
public static class PharosNotificationShortcut {
 [DllImport("shell32.dll",CharSet=CharSet.Unicode,PreserveSig=false)] private static extern void SHGetPropertyStoreFromParsingName(string path,IntPtr binding,uint flags,ref Guid iid,out IPharosShortcutStore store);
 [DllImport("ole32.dll")] private static extern int PropVariantClear(ref PharosShortcutValue value);
 private static IPharosShortcutStore Open(string path,bool write) { var iid=typeof(IPharosShortcutStore).GUID;IPharosShortcutStore store;SHGetPropertyStoreFromParsingName(path,IntPtr.Zero,write?2u:0u,ref iid,out store);return store; }
 public static string Read(string path,uint property) { var store=Open(path,false);var key=new PharosShortcutKey(property);PharosShortcutValue value;store.GetValue(ref key,out value);try { if(value.Type==31)return Marshal.PtrToStringUni(value.Pointer);if(value.Type==72)return ((Guid)Marshal.PtrToStructure(value.Pointer,typeof(Guid))).ToString();return "VT="+value.Type; } finally { PropVariantClear(ref value);Marshal.FinalReleaseComObject(store); } }
 public static void Write(string path) { var store=Open(path,true);try {
  var id=new PharosShortcutKey(5);var text=new PharosShortcutValue{Type=31,Pointer=Marshal.StringToCoTaskMemUni("LeoCjw.DshPharos")};try { store.SetValue(ref id,ref text); } finally { PropVariantClear(ref text); }
  var clsid=new PharosShortcutKey(26);var guid=new PharosShortcutValue{Type=72,Pointer=Marshal.AllocCoTaskMem(16)};Marshal.StructureToPtr(new Guid("1D9DF316-599A-4CAB-8FF9-F0F012928FCA"),guid.Pointer,false);try { store.SetValue(ref clsid,ref guid); } finally { PropVariantClear(ref guid); }
  store.Commit();
 } finally { Marshal.FinalReleaseComObject(store); } }
}
