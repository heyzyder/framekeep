// A stable, icon-bearing Windows process hosts the globally installed Python runtime.
// UI/helper updates do not replace this executable unless its source or icon changes.
using System;
using System.IO;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;
using System.Windows.Forms;
[assembly: System.Reflection.AssemblyTitle("Framekeep")]
[assembly: System.Reflection.AssemblyProduct("Framekeep")]
[assembly: System.Reflection.AssemblyVersion("1.0.0.0")]
static class Framekeep {
    [DllImport("kernel32", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr LoadLibraryEx(string path, IntPtr reserved, uint flags);
    [DllImport("kernel32", CharSet=CharSet.Ansi)] static extern IntPtr GetProcAddress(IntPtr module, string name);
    [DllImport("shell32")] static extern int SetCurrentProcessExplicitAppUserModelID([MarshalAs(UnmanagedType.LPWStr)] string id);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int PythonMain(int argc, IntPtr argv);
    [STAThread] static int Main(string[] args) {
        try {
            SetCurrentProcessExplicitAppUserModelID("Framekeep.Desktop");
            string directory = AppDomain.CurrentDomain.BaseDirectory;
            var json = new JavaScriptSerializer();
            var config = json.Deserialize<Dictionary<string,object>>(File.ReadAllText(Path.Combine(directory,"launcher.json")));
            string python = (string)config["python"], dll = (string)config["dll"];
            if (!File.Exists(python) || !File.Exists(dll)) throw new Exception("The Python installation moved. Run Install Framekeep.cmd to repair it.");
            // Set only this process's environment. Never install/copy a private interpreter.
            Environment.SetEnvironmentVariable("PYTHONHOME", Path.GetDirectoryName(python));
            Environment.SetEnvironmentVariable("PYTHONNET_PYDLL", dll);
            IntPtr module = LoadLibraryEx(dll, IntPtr.Zero, 8);
            if (module == IntPtr.Zero) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            var run = (PythonMain)Marshal.GetDelegateForFunctionPointer(GetProcAddress(module,"Py_Main"),typeof(PythonMain));
            string script = Path.Combine(directory,"desktop.pyw");
            // JSON loads the configuration/arguments as data; no path is interpolated as code.
            string data = json.Serialize(new {python=python,script=script,args=args});
            string encoded = Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes(data));
            string code = "import sys,json,base64,runpy,os; c=json.loads(base64.b64decode('"+encoded+"')); sys.executable=c['python']; sys.argv=[c['script']]+c['args']; sys.path.insert(0,os.path.dirname(c['script'])); runpy.run_path(c['script'],run_name='__main__')";
            string[] argv = {python,"-X","utf8","-B","-c",code};
            IntPtr vector=Marshal.AllocHGlobal(IntPtr.Size*argv.Length);
            var values=new List<IntPtr>();
            try { for(int i=0;i<argv.Length;i++){IntPtr value=Marshal.StringToHGlobalUni(argv[i]);values.Add(value);Marshal.WriteIntPtr(vector,i*IntPtr.Size,value);} return run(argv.Length,vector); }
            finally {foreach(var value in values) Marshal.FreeHGlobal(value);Marshal.FreeHGlobal(vector);}
        } catch(Exception error) {MessageBox.Show(error.Message,"Framekeep could not start",MessageBoxButtons.OK,MessageBoxIcon.Error);return 1;}
    }
}
