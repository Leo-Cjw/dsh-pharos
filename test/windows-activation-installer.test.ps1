# Exercise the production installer in isolated test keys and temporary files.
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$fixture=[Console]::In.ReadToEnd()|ConvertFrom-Json
$suffix=[Guid]::NewGuid().ToString('N')
$testKey='Software\PharosActivationTests\'+$suffix
$testFolder=Join-Path ([IO.Path]::GetTempPath()) ('pharos-activation-test-'+$suffix)
if([IO.Path]::GetFullPath($testFolder) -cne (Join-Path ([IO.Path]::GetTempPath()) ('pharos-activation-test-'+$suffix))) {throw 'invalid test boundary'}
function SharedSnapshot {
 $key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\RegisteredApplications')
 if($null -eq $key){return 'missing'}
 try { return (@($key.GetValueNames()|Sort-Object|ForEach-Object{@{name=$_;kind=$key.GetValueKind($_).ToString();value=$key.GetValue($_)}})|ConvertTo-Json -Depth 5 -Compress) }
 finally {$key.Dispose()}
}
$sharedBefore=SharedSnapshot
$null=[IO.Directory]::CreateDirectory($testFolder)
$quoteFolder="'"+$testFolder.Replace("'","''")+"'"
$isolated=$fixture.installer.Replace('$options=[Console]::In.ReadToEnd()|ConvertFrom-Json','$options=$fixture')
$isolated=$isolated.Replace('Software\Classes\AppUserModelId\LeoCjw.DshPharos',$testKey+'\Aumid')
$isolated=$isolated.Replace('Software\Classes\CLSID\{1D9DF316-599A-4CAB-8FF9-F0F012928FCA}',$testKey+'\Clsid')
$isolated=$isolated.Replace("([Environment]::GetFolderPath('Programs'))",$quoteFolder)
$isolated=$isolated.Replace("([Environment]::GetFolderPath('LocalApplicationData'))",$quoteFolder)
try {
 foreach($part in @('Aumid','Clsid')) {
  $key=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($testKey+'\'+$part)
  try {$key.SetValue('PharosOwner','Leo-Cjw/dsh-pharos');$key.SetValue('Sentinel','keep-existing-value')}
  finally {$key.Dispose()}
 }
 $installer=[scriptblock]::Create($isolated)
 . $installer
 . $installer
 foreach($part in @('Aumid','Clsid')) {
  $key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($testKey+'\'+$part)
  try {if($key.GetValue('Sentinel') -cne 'keep-existing-value'){throw 'installer cleared existing values'}}
  finally {$key.Dispose()}
 }
 $link=Join-Path $testFolder 'DSH Pharos Notifications.lnk'
 if([PharosNotificationShortcut]::Read($link,5) -cne 'LeoCjw.DshPharos' -or
    [PharosNotificationShortcut]::Read($link,26) -cne '1d9df316-599a-4cab-8ff9-f0f012928fca') {throw 'real shortcut identity mismatch'}
 $key=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($testKey+'\Aumid')
 try {$key.SetValue('PharosOwner','another-owner')}
 finally {$key.Dispose()}
 $rejected=$false
 try {. $installer} catch {$rejected=$true}
 if(-not $rejected){throw 'foreign registry owner was accepted'}
 if((SharedSnapshot) -cne $sharedBefore){throw 'shared registration changed'}
 [Console]::Out.WriteLine('PASS: installer preserves values, persists real shortcut properties, rejects foreign ownership and leaves shared registration unchanged')
} finally {
 # These targets were generated above and never come from fixture input.
 if($testKey -cnotmatch '^Software\\PharosActivationTests\\[0-9a-f]{32}$'){throw 'invalid registry cleanup target'}
 [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($testKey,$false)
 if([IO.Directory]::Exists($testFolder)){[IO.Directory]::Delete($testFolder,$true)}
}
