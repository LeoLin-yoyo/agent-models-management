' Hidden launcher for agent-models-management (ammp).
' Usage:  wscript //nologo //B run_hidden.vbs "<path\to\launch.cmd>" [args...]
' Runs the given .cmd in a completely hidden window (0 = hidden, False = don't wait),
' so no console window ever appears for the service or the QUIC bridge it spawns.
Option Explicit

Dim sh, args, i, cmd
Set sh = CreateObject("WScript.Shell")
Set args = WScript.Arguments

If args.Count < 1 Then
  WScript.Echo "usage: run_hidden.vbs <launch.cmd> [args...]"
  WScript.Quit 2
End If

cmd = "cmd /c """ & args(0) & """"
For i = 1 To args.Count - 1
  cmd = cmd & " " & args(i)
Next

sh.Run cmd, 0, False
