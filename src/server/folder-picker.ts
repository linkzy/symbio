// Native "choose a folder" dialog, opened by the Symbio server on the user's own
// machine (browsers can't reveal full paths). Windows uses the modern shell
// dialog (IFileOpenDialog with FOS_PICKFOLDERS) through Windows PowerShell 5.1,
// which every Windows has; macOS uses osascript, Linux zenity/kdialog.

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const WINDOWS_SCRIPT = String.raw`
param([string]$Initial = "", [string]$Title = "Choose the project folder")
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
Add-Type -ReferencedAssemblies System.Windows.Forms -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public static class SymbioFolderPicker {
  [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")] private class FileOpenDialogCom {}

  [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IFileOpenDialog {
    [PreserveSig] int Show(IntPtr hwndOwner);
    void SetFileTypes(); void SetFileTypeIndex(); void GetFileTypeIndex(); void Advise(); void Unadvise();
    void SetOptions(uint fos);
    void GetOptions(out uint fos);
    void SetDefaultFolder(IShellItem psi);
    void SetFolder(IShellItem psi);
    void GetFolder(); void GetCurrentSelection(); void SetFileName(); void GetFileName();
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
    void SetFileNameLabel();
    void GetResult(out IShellItem ppsi);
  }

  [ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IShellItem {
    void BindToHandler(); void GetParent();
    void GetDisplayName(uint sigdnName, [MarshalAs(UnmanagedType.LPWStr)] out string ppszName);
    void GetAttributes(); void Compare();
  }

  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  private static extern void SHCreateItemFromParsingName(string pszPath, IntPtr pbc, [MarshalAs(UnmanagedType.LPStruct)] Guid riid, out IShellItem ppv);

  public static string Pick(string initial, string title) {
    // An invisible topmost window owns the dialog so it opens in front of the browser.
    var owner = new Form { ShowInTaskbar = false, TopMost = true, FormBorderStyle = FormBorderStyle.None, Opacity = 0, Width = 1, Height = 1, StartPosition = FormStartPosition.CenterScreen };
    owner.Show();
    owner.Activate();
    try {
      var dialog = (IFileOpenDialog)new FileOpenDialogCom();
      dialog.SetOptions(0x20 | 0x40 | 0x800); // PICKFOLDERS | FORCEFILESYSTEM | PATHMUSTEXIST
      dialog.SetTitle(title);
      dialog.SetOkButtonLabel("Select folder");
      if (!String.IsNullOrEmpty(initial)) {
        try {
          IShellItem folder;
          SHCreateItemFromParsingName(initial, IntPtr.Zero, typeof(IShellItem).GUID, out folder);
          dialog.SetFolder(folder);
        } catch { }
      }
      int hr = dialog.Show(owner.Handle);
      if (hr != 0) return null; // cancelled
      IShellItem result;
      dialog.GetResult(out result);
      string p;
      result.GetDisplayName(0x80058000, out p); // SIGDN_FILESYSPATH
      return p;
    } finally {
      owner.Close();
    }
  }
}
"@
$picked = [SymbioFolderPicker]::Pick($Initial, $Title)
if ($picked) { [Console]::Out.Write($picked) }
`;

let busy = false;

/** Opens the native folder dialog. Resolves to the chosen path, or null if cancelled. */
export async function pickFolder(initial?: string): Promise<string | null> {
  if (busy) throw new Error("A folder dialog is already open.");
  busy = true;
  try {
    if (process.platform === "win32") return await pickWindows(initial);
    if (process.platform === "darwin") {
      const out = await run("osascript", ["-e", `POSIX path of (choose folder with prompt "Choose the project folder")`]);
      return out.trim().replace(/\/$/, "") || null;
    }
    const out = await run("zenity", ["--file-selection", "--directory", "--title=Choose the project folder"]).catch(() =>
      run("kdialog", ["--getexistingdirectory", initial ?? os.homedir()]),
    );
    return out.trim() || null;
  } finally {
    busy = false;
  }
}

async function pickWindows(initial?: string): Promise<string | null> {
  const script = path.join(os.tmpdir(), "symbio-pick-folder.ps1");
  // UTF-8 with BOM so Windows PowerShell 5.1 reads non-ASCII text correctly.
  await fs.writeFile(script, "﻿" + WINDOWS_SCRIPT, "utf8");
  const args = ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-File", script];
  if (initial) args.push("-Initial", initial);
  const out = await run("powershell.exe", args);
  return out.trim() || null;
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { encoding: "utf8", windowsHide: false, timeout: 15 * 60_000 }, (err, stdout, stderr) => {
      // zenity/osascript exit non-zero when the user cancels.
      if (err && !stdout) {
        const cancelled = /cancel/i.test(stderr) || ((err as any).code === 1 && !stderr.trim());
        return cancelled ? resolve("") : reject(new Error(stderr.trim() || err.message));
      }
      resolve(stdout);
    });
  });
}
