"""A test-only PTY bridge; credentials travel only through its standard input."""

import errno
import os
import pty
import select
import signal
import sys
import time


def write_all(descriptor, value):
    pending = memoryview(value)
    while pending:
        pending = pending[os.write(descriptor, pending):]


def run():
    if len(sys.argv) < 2:
        return 1
    child, terminal = pty.fork()
    if child == 0:
        try:
            os.execvp(sys.argv[1], sys.argv[1:])
        except BaseException:
            os.write(2, b"Operator terminal command could not start.\n")
            os._exit(127)

    shutdown_at = None
    termination_signal = signal.SIGTERM
    child_status = None
    output_open = True
    terminal_open = True

    def forward(kind):
        try:
            os.killpg(child, kind)
        except ProcessLookupError:
            pass

    def stop(kind=signal.SIGTERM, _frame=None):
        nonlocal shutdown_at, termination_signal
        if shutdown_at is None:
            termination_signal = kind
            shutdown_at = time.monotonic()
            forward(kind)

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGHUP, stop)
    signal.signal(signal.SIGPIPE, signal.SIG_IGN)

    try:
        while True:
            if child_status is None:
                waited, status = os.waitpid(child, os.WNOHANG)
                if waited:
                    child_status = status
            if shutdown_at is not None:
                elapsed = time.monotonic() - shutdown_at
                if elapsed >= 0.4:
                    forward(signal.SIGKILL)
                if elapsed >= 0.8:
                    # The Node parent has its own final kill bound. Make the
                    # child-group kill attempt before allowing that deadline.
                    forward(signal.SIGKILL)
                    return 128 + termination_signal
            descriptors = [terminal] if terminal_open else []
            if child_status is None and shutdown_at is None:
                descriptors.append(sys.stdin.fileno())
            if not descriptors:
                if child_status is not None:
                    break
                time.sleep(0.02)
                continue
            try:
                readable, _, _ = select.select(descriptors, [], [], 0.05)
            except InterruptedError:
                continue
            if not readable and child_status is not None:
                break
            for descriptor in readable:
                if descriptor == terminal:
                    try:
                        chunk = os.read(terminal, 65_536)
                    except OSError as error:
                        if error.errno != errno.EIO:
                            raise
                        chunk = b""
                    if not chunk:
                        terminal_open = False
                    elif output_open:
                        try:
                            write_all(sys.stdout.fileno(), chunk)
                        except BrokenPipeError:
                            output_open = False
                            stop()
                else:
                    chunk = os.read(sys.stdin.fileno(), 65_536)
                    if chunk:
                        try:
                            write_all(terminal, chunk)
                        except OSError:
                            stop()
                    else:
                        stop()
        return os.waitstatus_to_exitcode(child_status) if child_status is not None else 1
    finally:
        if child_status is None:
            forward(signal.SIGKILL)
            try:
                os.waitpid(child, os.WNOHANG)
            except ChildProcessError:
                pass
        os.close(terminal)


try:
    result = run()
except Exception:
    # No command, environment, terminal output or credentials enter diagnostics.
    os.write(2, b"Operator terminal transport failed.\n")
    sys.exit(1)
else:
    sys.exit(result if result >= 0 else 128 - result)
