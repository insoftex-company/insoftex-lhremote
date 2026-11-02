Set fs = CreateObject("Scripting.FileSystemObject")
script = fs.BuildPath(fs.GetParentFolderName(WScript.ScriptFullName), "launch-linkedhelper-silent.cmd")
CreateObject("WScript.Shell").Run "cmd /c """ & script & """", 0, False
