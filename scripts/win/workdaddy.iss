#ifndef AppVersion
  #error AppVersion must be supplied by build-win-installer.ps1
#endif
#ifndef ProfileId
  #error ProfileId must be supplied by build-win-installer.ps1
#endif
#ifndef ProductName
  #error ProductName must be supplied by build-win-installer.ps1
#endif
#ifndef PackageName
  #error PackageName must be supplied by build-win-installer.ps1
#endif
#ifndef AppGuid
  #error AppGuid must be supplied by build-win-installer.ps1
#endif
#ifndef StageRoot
  #error StageRoot must be supplied by build-win-installer.ps1
#endif
#ifndef OutputDir
  #error OutputDir must be supplied by build-win-installer.ps1
#endif
#ifndef StartDescription
  #error StartDescription must be supplied by build-win-installer.ps1
#endif

#define AppUrl "https://github.com/babygoton/WorkDaddy"
#define PowerShellPath "{sysnative}\WindowsPowerShell\v1.0\powershell.exe"
#define PersistentPowerShellPath "{win}\System32\WindowsPowerShell\v1.0\powershell.exe"

[Setup]
AppId={#AppGuid}
AppName={#ProductName}
AppVersion={#AppVersion}
AppVerName={#ProductName} {#AppVersion}
AppPublisher={#ProductName} 团队
AppPublisherURL={#AppUrl}
AppSupportURL={#AppUrl}
AppUpdatesURL=https://github.com/babygoton/WorkDaddy/releases
DefaultDirName={localappdata}\Programs\{#ProductName}
DefaultGroupName={#ProductName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
WizardStyle=modern
Compression=lzma2/ultra64
SolidCompression=yes
OutputDir={#OutputDir}
OutputBaseFilename={#PackageName}-Setup-{#AppVersion}
SetupLogging=yes
CloseApplications=no
RestartApplications=no
RestartIfNeededByRun=no
MinVersion=10.0
UninstallDisplayName={#ProductName}

[Languages]
Name: "chinesesimplified"; MessagesFile: "ChineseSimplified.isl"

[Files]
Source: "{#StageRoot}\scripts\prepare-win-install.ps1"; Flags: dontcopy
Source: "{#StageRoot}\scripts\windows-process-boundary.ps1"; Flags: dontcopy
Source: "{#StageRoot}\scripts\*"; DestDir: "{app}\scripts"; Excludes: "prepare-win-install.ps1,runtime\node\*"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#StageRoot}\scripts\runtime\node\*"; DestDir: "{app}\scripts\runtime\node"; Flags: ignoreversion recursesubdirs createallsubdirs; Check: ShouldReplaceRuntime

[Icons]
Name: "{group}\{#ProductName}"; Filename: "{sys}\wscript.exe"; Parameters: "//nologo ""{app}\scripts\launcher-hidden.vbs"""; WorkingDir: "{app}\scripts"; IconFilename: "{app}\scripts\WorkDaddy.ico"
Name: "{userdesktop}\{#ProductName}"; Filename: "{sys}\wscript.exe"; Parameters: "//nologo ""{app}\scripts\launcher-hidden.vbs"""; WorkingDir: "{app}\scripts"; IconFilename: "{app}\scripts\WorkDaddy.ico"

[Run]
Filename: "{#PowerShellPath}"; Description: "{#StartDescription}"; Parameters: "-NoProfile -WindowStyle Hidden -ExecutionPolicy RemoteSigned -File ""{app}\scripts\install-win.ps1"" -SrcDir ""{app}\scripts"" -AppDir ""{app}"" -Profile ""{#ProfileId}"""; WorkingDir: "{app}\scripts"; Flags: waituntilterminated postinstall skipifsilent

[UninstallRun]
Filename: "{#PowerShellPath}"; Parameters: "-NoProfile -WindowStyle Hidden -ExecutionPolicy RemoteSigned -File ""{app}\scripts\uninstall-win.ps1"" -AppDir ""{app}"" -Profile ""{#ProfileId}"" -SkipAppRemoval"; WorkingDir: "{app}\scripts"; Flags: waituntilterminated

[UninstallDelete]
Type: filesandordirs; Name: "{app}"

[Code]
var
  PreserveExistingLifecycle: Boolean;

function ShouldReplaceRuntime(): Boolean;
begin
  Result := not PreserveExistingLifecycle;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
  Parameters: String;
begin
  Result := '';
  if not DirExists(ExpandConstant('{app}')) then
    exit;

  ExtractTemporaryFile('prepare-win-install.ps1');
  ExtractTemporaryFile('windows-process-boundary.ps1');
  Parameters := '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' +
    ExpandConstant('{tmp}\prepare-win-install.ps1') + '" -BoundaryPath "' +
    ExpandConstant('{tmp}\windows-process-boundary.ps1') + '" -AppDir "' +
    ExpandConstant('{app}') + '" -Profile "{#ProfileId}" -ExpectedVersion "{#AppVersion}"';
  if not Exec(ExpandConstant('{#PowerShellPath}'), Parameters, '', SW_HIDE,
      ewWaitUntilTerminated, ResultCode) then
  begin
    Result := '无法启动安装前的 WorkDaddy 进程检查。';
    exit;
  end;
  if ResultCode = 10 then
  begin
    PreserveExistingLifecycle := True;
    Result := '';
  end
  else if ResultCode = 5 then
    Result := '无法判断安装程序的权限。请关闭安全软件对 PowerShell 的拦截后，重新打开安装包。'
  else if ResultCode <> 0 then
    Result := '安装被后台进程阻止：可能存在管理员权限运行的旧版 WorkDaddy，当前安装程序无法确认并停止它。请先退出 WorkBuddy；仍无法安装时，请右键以管理员身份运行本安装包一次完成迁移。';
end;
