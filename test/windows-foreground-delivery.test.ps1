# Exercise the real two-phase COM delivery against an isolated loopback fixture.
# The foreground grant is a fake delegate: this test never focuses windows.
$ErrorActionPreference='Stop'
$fixture=[Console]::In.ReadToEnd()|ConvertFrom-Json
$probe=@'
public static class PharosForegroundProbe {
 public static int Calls;
 public static bool Deliver(string arguments,bool granted) {
  return PharosNotificationActivation.Deliver(arguments,()=>{Calls++;return granted;});
 }
}
'@
Add-Type -TypeDefinition ($fixture.source+"`n"+$probe)
if([PharosNotificationActivation]::ConfigureDesktopProcess(0) -or
   [PharosNotificationActivation]::ConfigureDesktopProcess([Diagnostics.Process]::GetCurrentProcess().Id)) {
 throw 'non-DSH foreground owner must be rejected'
}
foreach($case in $fixture.cases) {
 $before=[PharosForegroundProbe]::Calls
 $result=[PharosForegroundProbe]::Deliver(($fixture.port.ToString()+'/'+$case.ticket),$case.granted)
 if($result -ne $case.expected -or ([PharosForegroundProbe]::Calls-$before) -ne $case.grantCalls) {
  throw ('foreground delivery mismatch: '+$case.ticket.Substring(0,1))
 }
}
[Console]::Out.WriteLine('PASS: each click grants after live prepare, off/expired skip grant, grant failure still navigates')
