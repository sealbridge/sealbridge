"""Real Windows console input/output, without opening a visible window."""
import ctypes as c
from ctypes import wintypes as w
import json
import re
import subprocess
import sys
import time

shell, script, mode = sys.argv[1:]
k = c.WinDLL('kernel32', use_last_error=True)
HANDLE = w.HANDLE
SIZE = c.c_size_t

class COORD(c.Structure):
    _fields_ = [('X', c.c_short), ('Y', c.c_short)]

class STARTUPINFO(c.Structure):
    _fields_ = [('cb', w.DWORD), ('lpReserved', w.LPWSTR), ('lpDesktop', w.LPWSTR),
                ('lpTitle', w.LPWSTR), ('dwX', w.DWORD), ('dwY', w.DWORD),
                ('dwXSize', w.DWORD), ('dwYSize', w.DWORD), ('dwXCountChars', w.DWORD),
                ('dwYCountChars', w.DWORD), ('dwFillAttribute', w.DWORD),
                ('dwFlags', w.DWORD), ('wShowWindow', w.WORD), ('cbReserved2', w.WORD),
                ('lpReserved2', c.c_void_p), ('hStdInput', HANDLE), ('hStdOutput', HANDLE), ('hStdError', HANDLE)]

class STARTUPINFOEX(c.Structure):
    _fields_ = [('StartupInfo', STARTUPINFO), ('lpAttributeList', c.c_void_p)]

class PROCESS_INFORMATION(c.Structure):
    _fields_ = [('hProcess', HANDLE), ('hThread', HANDLE), ('dwProcessId', w.DWORD), ('dwThreadId', w.DWORD)]

k.CreatePipe.argtypes = [c.POINTER(HANDLE), c.POINTER(HANDLE), c.c_void_p, w.DWORD]
k.CreatePseudoConsole.argtypes = [COORD, HANDLE, HANDLE, w.DWORD, c.POINTER(HANDLE)]
k.InitializeProcThreadAttributeList.argtypes = [c.c_void_p, w.DWORD, w.DWORD, c.POINTER(SIZE)]
k.UpdateProcThreadAttribute.argtypes = [c.c_void_p, w.DWORD, SIZE, c.c_void_p, SIZE, c.c_void_p, c.c_void_p]
k.CreateProcessW.argtypes = [w.LPCWSTR, w.LPWSTR, c.c_void_p, c.c_void_p, w.BOOL, w.DWORD, c.c_void_p, w.LPCWSTR, c.POINTER(STARTUPINFOEX), c.POINTER(PROCESS_INFORMATION)]
k.PeekNamedPipe.argtypes = [HANDLE, c.c_void_p, w.DWORD, c.c_void_p, c.POINTER(w.DWORD), c.c_void_p]
k.ReadFile.argtypes = [HANDLE, c.c_void_p, w.DWORD, c.POINTER(w.DWORD), c.c_void_p]
k.WriteFile.argtypes = k.ReadFile.argtypes
k.WaitForSingleObject.argtypes = [HANDLE, w.DWORD]
k.GetExitCodeProcess.argtypes = [HANDLE, c.POINTER(w.DWORD)]
k.CloseHandle.argtypes = [HANDLE]
k.ClosePseudoConsole.argtypes = [HANDLE]
k.TerminateProcess.argtypes = [HANDLE, w.UINT]
k.DeleteProcThreadAttributeList.argtypes = [c.c_void_p]
k.GetStdHandle.argtypes = [w.DWORD]
k.GetStdHandle.restype = HANDLE
k.SetStdHandle.argtypes = [w.DWORD, HANDLE]

def check(value):
    if not value:
        raise c.WinError(c.get_last_error())

ir, iw, out_r, out_w, pc = HANDLE(), HANDLE(), HANDLE(), HANDLE(), HANDLE()
check(k.CreatePipe(c.byref(ir), c.byref(iw), None, 0))
check(k.CreatePipe(c.byref(out_r), c.byref(out_w), None, 0))
assert k.CreatePseudoConsole(COORD(160, 50), ir, out_w, 0, c.byref(pc)) == 0
size = SIZE()
k.InitializeProcThreadAttributeList(None, 1, 0, c.byref(size))
attributes = c.create_string_buffer(size.value)
check(k.InitializeProcThreadAttributeList(attributes, 1, 0, c.byref(size)))
check(k.UpdateProcThreadAttribute(attributes, 0, 0x00020016, pc, c.sizeof(HANDLE), None, None))
startup = STARTUPINFOEX()
startup.StartupInfo.cb = c.sizeof(startup)
startup.lpAttributeList = c.cast(attributes, c.c_void_p)
process = PROCESS_INFORMATION()
command = c.create_unicode_buffer(subprocess.list2cmdline([shell, '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script]))
# Do not let the test runner's redirected standard handles override ConPTY's
# console handles. Restore this process's handles immediately after creation.
saved = [(code, k.GetStdHandle(code)) for code in (-10, -11, -12)]
try:
    for code, _ in saved:
        check(k.SetStdHandle(code, None))
    check(k.CreateProcessW(None, command, None, None, False, 0x00080000, None, None, c.byref(startup), c.byref(process)))
finally:
    for code, handle in saved:
        check(k.SetStdHandle(code, handle))
k.CloseHandle(ir)
k.CloseHandle(out_w)
output = b''
sent = confirmed = False
deadline = time.monotonic() + 25

def send(value):
    count = w.DWORD()
    check(k.WriteFile(iw, value, len(value), c.byref(count), None))

try:
    while time.monotonic() < deadline:
        available = w.DWORD()
        if k.PeekNamedPipe(out_r, None, 0, None, c.byref(available), None) and available.value:
            buffer = c.create_string_buffer(available.value)
            count = w.DWORD()
            check(k.ReadFile(out_r, buffer, available.value, c.byref(count), None))
            output += buffer.raw[:count.value]
        text = re.sub(rb'\x1b\[[0-?]*[ -/]*[@-~]', b'', output)
        if not sent and b'or press Enter to skip' in text:
            sent = True
            # Read-Host's prompt appears after it has entered secure input mode.
            time.sleep(0.1)
            send(b'\r' if mode == 'empty' else b'sealbridge://join#synthetic-private-invite-249\r')
        if sent and not confirmed and b'Type y to accept [y/N]' in text:
            confirmed = True
            time.sleep(0.1)
            send(b'n\r' if mode == 'decline' else b'y\r')
        if k.WaitForSingleObject(process.hProcess, 0) == 0:
            break
        time.sleep(0.02)
    else:
        raise RuntimeError('Console prompt timed out')
    code = w.DWORD()
    check(k.GetExitCodeProcess(process.hProcess, c.byref(code)))
    assert b'synthetic-private-invite-249' not in output, 'invitation leaked'
    print(json.dumps(dict(status=code.value, prompted=sent, confirmed=confirmed, output=text.decode(errors='replace'))))
finally:
    if k.WaitForSingleObject(process.hProcess, 0) != 0:
        k.TerminateProcess(process.hProcess, 99)
    k.ClosePseudoConsole(pc)
    k.DeleteProcThreadAttributeList(attributes)
    for handle in (iw, out_r, process.hThread, process.hProcess):
        k.CloseHandle(handle)
