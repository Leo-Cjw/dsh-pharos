# Fixed helper: commands arrive as JSON on stdin, never as executable source.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$null = [Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]
$null = [Windows.UI.Notifications.ToastNotification,Windows.UI.Notifications,ContentType=WindowsRuntime]
$null = [Windows.Data.Xml.Dom.XmlDocument,Windows.Data.Xml.Dom.XmlDocument,ContentType=WindowsRuntime]
Add-Type -TypeDefinition @'
using System;
using System.Reflection;
using System.Collections.Concurrent;
using System.Threading;
public class PharosToastEvents {
 public static ConcurrentQueue<string> Input = new ConcurrentQueue<string>();
 public static ConcurrentQueue<string> Events = new ConcurrentQueue<string>();
 public static volatile bool Ended;
 public static void ReadInput() {
  var thread = new Thread(() => { try { string line; while ((line=Console.ReadLine())!=null) Input.Enqueue(line); } finally { Ended=true; } });
  thread.IsBackground=true; thread.Start();
 }
 public static void Activated(object sender, object args) { Events.Enqueue("activated:"+sender.GetType().GetProperty("Tag").GetValue(sender,null)); }
 public static void Dismissed(object sender, object args) {
  if(args.GetType().GetProperty("Reason").GetValue(args,null).ToString()=="UserCanceled") Events.Enqueue("closed:"+sender.GetType().GetProperty("Tag").GetValue(sender,null));
 }
 public static void Failed(object sender, object args) { Events.Enqueue("failed:"+sender.GetType().GetProperty("Tag").GetValue(sender,null)); }
 public static void Attach(object toast, string name) {
  var add=toast.GetType().GetMethod("add_"+name);
  var callback=Delegate.CreateDelegate(add.GetParameters()[0].ParameterType,typeof(PharosToastEvents).GetMethod(name));
  add.Invoke(toast,new object[]{callback});
 }
}
'@
$appId='electron.app.DeepSeek Harness'
$notifier=[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId)
$history=[Windows.UI.Notifications.ToastNotificationManager]::History
$toasts=@{}
function Reply($value) { [Console]::Out.WriteLine(($value|ConvertTo-Json -Compress)); [Console]::Out.Flush() }
function RemoveToast([string]$id) {
 if($toasts.ContainsKey($id)) { $notifier.Hide($toasts[$id]); $toasts.Remove($id) }
 $history.Remove($id,'Pharos',$appId)
 foreach($entry in $history.GetHistory($appId)) {
  if($entry.Group -ceq 'Pharos' -and $entry.Tag -ceq $id) { throw 'native history removal failed' }
 }
}
[PharosToastEvents]::ReadInput()
try {
 while(-not [PharosToastEvents]::Ended -or -not [PharosToastEvents]::Input.IsEmpty) {
  $line=$null
  while([PharosToastEvents]::Input.TryDequeue([ref]$line)) {
   $command=$null
   try {
    $command=$line|ConvertFrom-Json
    if($command.id -cnotmatch '^pharos-native-[0-9a-f]{24}$') { throw 'invalid native id' }
    if($command.op -ceq 'show') {
     if($toasts.Count -ge 512 -or $command.title -isnot [string] -or $command.body -isnot [string]) { throw 'invalid native notification' }
     $title=[Security.SecurityElement]::Escape($command.title)
     $body=[Security.SecurityElement]::Escape($command.body)
     $xml=[Windows.Data.Xml.Dom.XmlDocument]::new()
     $xml.LoadXml('<toast scenario="reminder"><visual><binding template="ToastGeneric"><text>'+ $title +'</text><text>'+ $body +'</text></binding></visual><actions><action activationType="system" arguments="dismiss" content="关闭"/></actions><audio silent="true"/></toast>')
     $toast=[Windows.UI.Notifications.ToastNotification]::new($xml)
     $toast.Tag=$command.id; $toast.Group='Pharos'
     # Keep the object/delegate after Dismissed/TimedOut. Action Center can still activate it.
     [PharosToastEvents]::Attach($toast,'Activated')
     [PharosToastEvents]::Attach($toast,'Dismissed')
     [PharosToastEvents]::Attach($toast,'Failed')
     $toasts[$command.id]=$toast
     $notifier.Show($toast)
    } elseif($command.op -ceq 'remove') { RemoveToast $command.id }
    else { throw 'unknown command' }
    Reply @{event='ack';id=$command.id;op=$command.op;ok=$true}
   } catch { Reply @{event='ack';id=$command.id;op=$command.op;ok=$false} }
  }
  $event=$null
  while([PharosToastEvents]::Events.TryDequeue([ref]$event)) {
   $parts=$event.Split(':',2); $id=$parts[1]
   if($toasts.ContainsKey($id)) { Reply @{event=$parts[0];id=$id} }
  }
  Start-Sleep -Milliseconds 40
 }
} finally {
 foreach($id in @($toasts.Keys)) { try { RemoveToast $id } catch {} }
}
