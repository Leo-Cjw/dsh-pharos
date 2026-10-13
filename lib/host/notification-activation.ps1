$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$options=[Console]::In.ReadToEnd()|ConvertFrom-Json
if($options.fingerprint -cnotmatch '^[0-9a-f]{64}$' -or $options.source -isnot [string]) { throw 'invalid activation source' }
$sourceHash=[Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($options.source))
$sourceHash=([BitConverter]::ToString($sourceHash)).Replace('-','').ToLowerInvariant()
if($sourceHash -cne $options.fingerprint) { throw 'activation source mismatch' }
Add-Type -TypeDefinition $options.source
$shortcut=Join-Path ([Environment]::GetFolderPath('Programs')) 'DSH Pharos Notifications.lnk'
if([IO.File]::Exists($shortcut)) {
 if([PharosNotificationShortcut]::Read($shortcut,5) -cne 'LeoCjw.DshPharos' -or
    [PharosNotificationShortcut]::Read($shortcut,26) -cne '1d9df316-599a-4cab-8ff9-f0f012928fca') {
  throw 'notification shortcut belongs to another application'
 }
}
$owner='Leo-Cjw/dsh-pharos'
$aumid='Software\Classes\AppUserModelId\LeoCjw.DshPharos'
$clsid='Software\Classes\CLSID\{1D9DF316-599A-4CAB-8FF9-F0F012928FCA}'
# Registry writes are limited to these private keys. No shared registration roots
# are recreated; CreateSubKey preserves existing values and children.
foreach($hive in @([Microsoft.Win32.Registry]::CurrentUser,[Microsoft.Win32.Registry]::LocalMachine)) {
 foreach($path in @($aumid,$clsid)) {
  $key=$hive.OpenSubKey($path)
  if($null -ne $key) {
   try { if($key.GetValue('PharosOwner',$null) -cne $owner) { throw 'notification registration belongs to another application' } }
   finally { $key.Dispose() }
  }
 }
}
$cache=Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'dsh-pharos\notifications'
$null=[IO.Directory]::CreateDirectory($cache)
$exe=Join-Path $cache ('activate-'+$sourceHash.Substring(0,16)+'.exe')
if(-not [IO.File]::Exists($exe)) { Add-Type -TypeDefinition $options.source -OutputAssembly $exe -OutputType WindowsApplication }
$command='"'+$exe+'" -ToastActivated'
$key=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($clsid)
try { $key.SetValue('PharosOwner',$owner) } finally { $key.Dispose() }
$key=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($clsid+'\LocalServer32')
try {
 $key.SetValue('',$command);$key.SetValue('ServerExecutable',$exe)
 if($key.GetValue('') -cne $command -or $key.GetValue('ServerExecutable') -cne $exe){throw 'notification COM registration readback failed'}
} finally { $key.Dispose() }
$key=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($aumid)
try {
 $key.SetValue('PharosOwner',$owner)
 $key.SetValue('DisplayName','DSH Pharos')
 $key.SetValue('CustomActivator','{1D9DF316-599A-4CAB-8FF9-F0F012928FCA}')
 if($key.GetValue('CustomActivator') -cne '{1D9DF316-599A-4CAB-8FF9-F0F012928FCA}') { throw 'notification AUMID registration readback failed' }
} finally { $key.Dispose() }
if(-not [IO.File]::Exists($shortcut)) {
 # Stage a new private link before moving it into Programs. Never alter DSH's link.
 $staged=Join-Path $cache ('shortcut-'+[Guid]::NewGuid().ToString('N')+'.lnk')
 $shell=$null;$link=$null
 try {
  $shell=New-Object -ComObject WScript.Shell
  $link=$shell.CreateShortcut($staged)
  $link.TargetPath=Join-Path ([Environment]::GetFolderPath('Windows')) 'explorer.exe'
  $link.Arguments='dsh://open'
  $link.Description='Leo-Cjw/dsh-pharos notifications'
  $link.Save()
  [PharosNotificationShortcut]::Write($staged)
  if([PharosNotificationShortcut]::Read($staged,5) -cne 'LeoCjw.DshPharos' -or
     [PharosNotificationShortcut]::Read($staged,26) -cne '1d9df316-599a-4cab-8ff9-f0f012928fca') {
   throw 'notification shortcut readback failed'
  }
  [IO.File]::Move($staged,$shortcut)
 } finally {
  if($null -ne $link){$null=[Runtime.InteropServices.Marshal]::FinalReleaseComObject($link)}
  if($null -ne $shell){$null=[Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell)}
  if([IO.File]::Exists($staged)){[IO.File]::Delete($staged)}
 }
}
[Console]::Out.WriteLine('registered')
