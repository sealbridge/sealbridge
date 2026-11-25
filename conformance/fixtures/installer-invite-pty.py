"""Exercise the actual POSIX prompt with a controlling PTY; synthetic data only."""
import errno
import json
import os
import pty
import re
import select
import signal
import subprocess
import sys
import termios
import time

script, mode = sys.argv[1:]
master, slave = pty.openpty()
before = termios.tcgetattr(slave)

def attach():
    os.setsid()
    import fcntl
    fcntl.ioctl(slave, termios.TIOCSCTTY, 0)

streams = dict(stdin=slave, stdout=slave, stderr=slave)
if mode in ('stdin', 'stdout', 'stderr'):
    streams[mode] = subprocess.DEVNULL
if mode == 'no-tty':
    streams = dict(stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
env = dict(os.environ)
for key in ('CI', 'CONTINUOUS_INTEGRATION', 'GITHUB_ACTIONS', 'TF_BUILD', 'BUILD_ID', 'JENKINS_URL'):
    env.pop(key, None)
if mode == 'ci':
    env['CI'] = 'true'
flags = {'trace': '-x', 'verbose': '-v', 'export': '-a'}
args = ['/bin/sh'] + ([flags[mode]] if mode in flags else []) + [script]
child = subprocess.Popen(args, **streams, env=env, preexec_fn=attach if mode != 'no-tty' else os.setsid)
output = b''
sent = False
confirmed = False
deadline = time.monotonic() + 12
try:
    while time.monotonic() < deadline:
        if select.select([master], [], [], 0.05)[0]:
            try:
                output += os.read(master, 65536)
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
        # Verbose shells print the function's source, including the prompt's
        # string literal. Only an actual terminal prompt may receive input.
        if not sent and re.search(rb'(?:^|[\r\n])Paste an invitation \(hidden\), or press Enter to skip: $', output):
            # The terminal must already have echo disabled before input arrives.
            assert not termios.tcgetattr(slave)[3] & termios.ECHO
            sent = True
            if mode == 'interrupt':
                os.killpg(child.pid, signal.SIGINT)
            else:
                value = b'\n' if mode == 'empty' else b'\x04' if mode == 'eof' else b'https://sealbridge.app/j#synthetic-private-invite-249\n'
                os.write(master, value)
        if sent and not confirmed and b'Type y to accept [y/N]: ' in output:
            confirmed = True
            assert not termios.tcgetattr(slave)[3] & termios.ECHO
            answer = {'decline': b'n\n', 'default': b'\n', 'confirm-eof': b'\x04', 'other': b'yes\n'}.get(mode, b'y\n')
            os.write(master, answer)
        if child.poll() is not None:
            while select.select([master], [], [], 0)[0]:
                output += os.read(master, 65536)
            break
    else:
        raise RuntimeError('prompt hung')
    restored = termios.tcgetattr(slave) == before
    assert b'synthetic-private-invite-249' not in output, 'invitation leaked'
    print(json.dumps(dict(status=child.returncode, prompted=sent, restored=restored, output=output.decode(errors='replace'))))
finally:
    if child.poll() is None:
        os.killpg(child.pid, signal.SIGKILL)
    child.wait()
    os.close(master)
    os.close(slave)
