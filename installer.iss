; Instalador de Windows (Inno Setup 6):  iscc installer.iss
#define MyAppName "Grabador STL"
#ifndef MyAppVersion
  #define MyAppVersion "1.0.0"
#endif

[Setup]
AppId={{8C2F4B1E-3D5A-4E7B-9A61-2B7C9D4E5F10}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher=Lorenzo Marañón
DefaultDirName={autopf}\GrabadorSTL
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
OutputDir=Output
OutputBaseFilename=GrabadorSTL-Setup
SetupIconFile=assets\icon.ico
UninstallDisplayIcon={app}\GrabadorSTL.exe
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ArchitecturesInstallIn64BitMode=x64compatible

[Languages]
Name: "spanish"; MessagesFile: "compiler:Languages\Spanish.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
Source: "dist\GrabadorSTL\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\GrabadorSTL.exe"
Name: "{group}\Desinstalar {#MyAppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\GrabadorSTL.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\GrabadorSTL.exe"; Description: "{cm:LaunchProgram,{#MyAppName}}"; Flags: nowait postinstall skipifsilent
