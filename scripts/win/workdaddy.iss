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
Source: "{#StageRoot}\WorkDaddyLauncher.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#StageRoot}\WorkDaddyLauncher.exe"; Flags: dontcopy
Source: "{#StageRoot}\scripts\*"; DestDir: "{app}\scripts"; Excludes: "runtime\node\*"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#StageRoot}\scripts\runtime\node\*"; DestDir: "{app}\scripts\runtime\node"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#ProductName}"; Filename: "{app}\WorkDaddyLauncher.exe"; WorkingDir: "{app}"; IconFilename: "{app}\scripts\WorkDaddy.ico"
Name: "{userdesktop}\{#ProductName}"; Filename: "{app}\WorkDaddyLauncher.exe"; WorkingDir: "{app}"; IconFilename: "{app}\scripts\WorkDaddy.ico"

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: none; ValueName: "WorkDaddy"; Flags: deletevalue
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: none; ValueName: "WorkDaddy AI"; Flags: deletevalue

[Run]
Filename: "{app}\WorkDaddyLauncher.exe"; Description: "{#StartDescription}"; WorkingDir: "{app}"; Flags: nowait postinstall skipifsilent runasoriginaluser

[UninstallRun]
Filename: "{app}\WorkDaddyLauncher.exe"; Parameters: "--stop-lifecycle --profile ""{#ProfileId}"" --app-dir ""{app}"""; WorkingDir: "{app}"; Flags: runhidden waituntilterminated; RunOnceId: "StopWorkDaddyLifecycle"

[UninstallDelete]
Type: filesandordirs; Name: "{app}"

[Code]
function RunNativeHelper(const Mode: String; var ResultCode: Integer): Boolean;
var
  Parameters: String;
begin
  ExtractTemporaryFile('WorkDaddyLauncher.exe');
  Parameters := Mode + ' --profile "{#ProfileId}" --app-dir "' + ExpandConstant('{app}') + '"';
  Result := ExecAsOriginalUser(
    ExpandConstant('{tmp}\WorkDaddyLauncher.exe'),
    Parameters,
    ExpandConstant('{tmp}'),
    SW_HIDE,
    ewWaitUntilTerminated,
    ResultCode
  );
end;

function ShowWorkBuddyCloseDialog(): Integer;
var
  Dialog: TSetupForm;
  MessageLabel: TNewStaticText;
  DetailLabel: TNewStaticText;
  RetryButton: TNewButton;
  TerminateButton: TNewButton;
  CancelButton: TNewButton;
begin
  Dialog := CreateCustomForm(ScaleX(480), ScaleY(196), False, False);
  try
    Dialog.Caption := '请先退出 WorkBuddy';
    Dialog.ClientWidth := ScaleX(480);
    Dialog.ClientHeight := ScaleY(196);
    Dialog.Position := poScreenCenter;

    MessageLabel := TNewStaticText.Create(Dialog);
    MessageLabel.Parent := Dialog;
    MessageLabel.Left := ScaleX(20);
    MessageLabel.Top := ScaleY(18);
    MessageLabel.Width := ScaleX(440);
    MessageLabel.Height := ScaleY(42);
    MessageLabel.AutoSize := False;
    MessageLabel.WordWrap := True;
    MessageLabel.Font.Style := [fsBold];
    MessageLabel.Caption := '安装前需要完全退出当前的 WorkBuddy。';

    DetailLabel := TNewStaticText.Create(Dialog);
    DetailLabel.Parent := Dialog;
    DetailLabel.Left := ScaleX(20);
    DetailLabel.Top := ScaleY(64);
    DetailLabel.Width := ScaleX(440);
    DetailLabel.Height := ScaleY(50);
    DetailLabel.AutoSize := False;
    DetailLabel.WordWrap := True;
    DetailLabel.Caption := '退出后点击“重新检测”。如果客户端窗口已关闭但后台进程仍未退出，可以点击“结束进程”。只处理当前客户端，不会影响另一个客户端。';

    RetryButton := TNewButton.Create(Dialog);
    RetryButton.Parent := Dialog;
    RetryButton.Width := ScaleX(104);
    RetryButton.Height := ScaleY(28);
    RetryButton.Left := Dialog.ClientWidth - ScaleX(330);
    RetryButton.Top := ScaleY(150);
    RetryButton.Caption := '重新检测';
    RetryButton.Default := True;
    RetryButton.ModalResult := mrOk;

    TerminateButton := TNewButton.Create(Dialog);
    TerminateButton.Parent := Dialog;
    TerminateButton.Width := ScaleX(104);
    TerminateButton.Height := ScaleY(28);
    TerminateButton.Left := Dialog.ClientWidth - ScaleX(216);
    TerminateButton.Top := ScaleY(150);
    TerminateButton.Caption := '结束进程';
    TerminateButton.ModalResult := mrYes;

    CancelButton := TNewButton.Create(Dialog);
    CancelButton.Parent := Dialog;
    CancelButton.Width := ScaleX(104);
    CancelButton.Height := ScaleY(28);
    CancelButton.Left := Dialog.ClientWidth - ScaleX(106);
    CancelButton.Top := ScaleY(150);
    CancelButton.Caption := '取消';
    CancelButton.Cancel := True;
    CancelButton.ModalResult := mrCancel;

    Result := Dialog.ShowModal();
  finally
    Dialog.Free();
  end;
end;

function EnsureWorkBuddyClosed(): Boolean;
var
  ResultCode: Integer;
  Choice: Integer;
begin
  Result := False;
  while True do
  begin
    if not RunNativeHelper('--check-workbuddy', ResultCode) then
    begin
      MsgBox('无法启动 WorkBuddy 进程检测。请检查安全软件是否拦截安装程序。', mbError, MB_OK);
      exit;
    end;
    if ResultCode = 0 then
    begin
      Result := True;
      exit;
    end;
    if ResultCode <> 10 then
    begin
      MsgBox('无法确认 WorkBuddy 是否已退出（错误码 ' + IntToStr(ResultCode) + '）。安装已停止。', mbError, MB_OK);
      exit;
    end;
    Choice := ShowWorkBuddyCloseDialog();
    if Choice = mrCancel then
      exit;
    if Choice = mrYes then
    begin
      if not RunNativeHelper('--terminate-workbuddy', ResultCode) then
      begin
        MsgBox('无法启动 WorkBuddy 结束进程操作。请检查安全软件是否拦截安装程序。', mbError, MB_OK);
        exit;
      end;
      if ResultCode <> 0 then
      begin
        MsgBox('无法安全结束当前 WorkBuddy 进程。可能原因：' + #13#10 +
          '• WorkBuddy 由其他用户或管理员权限启动，当前安装器无法跨权限结束；' + #13#10 +
          '• 系统正在退出客户端，进程状态暂时不可查询；' + #13#10 +
          '• 安全软件或系统策略阻止结束进程，或检测到多个安装目录。' + #13#10 +
          '请手动结束当前客户端后点击“重新检测”。', mbError, MB_OK);
      end;
    end;
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
begin
  Result := '';
  if IsAdminInstallMode then
  begin
    Result := '当前安装程序是以管理员权限运行的，无法继续安装。为避免 WorkDaddy 后台出现权限不一致，请点击“取消”，关闭安装程序后直接双击安装包重新运行；不要选择“以管理员身份运行”。UAC 无需关闭。';
    exit;
  end;
  if not EnsureWorkBuddyClosed() then
  begin
    Result := '无法确认 WorkBuddy 已退出。可能原因是客户端仍有后台进程、进程权限高于当前用户、系统正在退出客户端，或安全软件阻止了进程检测。请手动结束当前客户端后重新运行安装程序。';
    exit;
  end;

  if not RunNativeHelper('--stop-lifecycle', ResultCode) then
  begin
    Result := '无法启动 WorkDaddy 后台进程清理。可能原因是安装器原始用户权限不可用、安全软件拦截了临时 helper，或临时目录不可写。请点击“取消”，关闭安装程序后直接双击安装包重新运行；不要选择“以管理员身份运行”。UAC 无需关闭。';
    exit;
  end;
  if ResultCode = 11 then
    Result := '无法安全停止 WorkDaddy 后台进程。可能原因：' + #13#10 +
      '• 正在运行的 WorkDaddy 使用了高于当前安装器的权限，普通安装器不会跨权限强行结束；' + #13#10 +
      '• WorkDaddy 退出后仍有后台进程未及时结束，或文件仍被占用；' + #13#10 +
      '• 安全软件或系统策略阻止后台进程退出。' + #13#10 +
      '请手动结束 WorkDaddy 后重试，并确保 WorkDaddy 通过普通方式启动。'
  else if ResultCode <> 0 then
    Result := '无法安全停止 WorkDaddy 后台进程（错误码 ' + IntToStr(ResultCode) + '）。可能原因是进程仍在退出、文件被占用、安装目录不一致，或安全软件拦截。请手动结束 WorkDaddy 后重试。';
end;
