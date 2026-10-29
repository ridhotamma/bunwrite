"""Runs one Appwrite Python function execution in its own process.

`python3 runner-python.py <entrypoint>`: request JSON on stdin, result JSON on
the last stdout line after RESULT_MARKER. Mirrors the open-runtimes `context`
(req, res, log, error) the function was written against.

Streamed responses (`res.start`, `res.write_text`, ..., `res.end`) go out as
STREAM_MARKER lines on the real stdout while the function runs, so the server
can send each chunk to the client as soon as it is written.

The process runs in the function's folder. Imports look in the entrypoint's
folder first, then the function's folder, then `.python_packages` (where
`pip install` puts packages during the build; see PIP_TARGET in
deployments.ts), and only then in Python's own paths.
"""
import asyncio
import base64
import importlib.util
import inspect
import io
import json
import os
import sys
import traceback
import contextlib
from urllib.parse import parse_qsl

RESULT_MARKER = "__BUNWRITE_EXECUTION_RESULT__"
STREAM_MARKER = "__BUNWRITE_EXECUTION_STREAM__"


class Request:
    def __init__(self, data):
        path, _, query_string = data["path"].partition("?")
        self.method = data["method"]
        self.scheme = data["scheme"]
        self.host = data["host"]
        self.port = data["port"]
        self.path = path
        self.query_string = query_string
        self.query = dict(parse_qsl(query_string))
        self.headers = data["headers"]
        self.url = f"{self.scheme}://{self.host}{data['path']}"
        self.body_raw = data["body"]
        self.body_text = data["body"]
        # The raw bytes when the request came over HTTP; `body` is their UTF-8 reading.
        raw = data.get("bodyBase64")
        self.body_binary = base64.b64decode(raw) if raw is not None else data["body"].encode("utf-8")

    @property
    def body_json(self):
        return json.loads(self.body_raw) if self.body_raw else {}

    @property
    def body(self):
        if self.headers.get("content-type", "").lower().startswith("application/json"):
            try:
                return self.body_json
            except ValueError:
                return self.body_raw
        return self.body_raw


class Response:
    def __init__(self, out=None):
        # The real stdout: what the function prints is captured as its log.
        self._out = out or sys.stdout
        self._stream = None

    def _frame(self, data):
        self._out.write("\n" + STREAM_MARKER + json.dumps(data) + "\n")
        self._out.flush()

    def start(self, status_code=200, headers=None):
        """Begin a streamed response; send the body with the write_* calls, then end()."""
        if self._stream is not None:
            raise RuntimeError("The response has already started.")
        self._stream = {"statusCode": status_code, "headers": headers or {}, "ended": False}
        self._frame({"type": "start", "statusCode": status_code, "headers": headers or {}})

    def _write(self, data):
        if self._stream is None:
            self.start()
        if self._stream["ended"]:
            raise RuntimeError("The response has already ended.")
        if data:
            self._frame({"type": "chunk", "data": base64.b64encode(data).decode("ascii")})

    def write_text(self, text):
        self._write(str(text).encode("utf-8"))

    def write_json(self, obj):
        self._write(json.dumps(obj).encode("utf-8"))

    def write_binary(self, data):
        self._write(bytes(data))

    def end(self):
        """Finish a streamed response. Return its result from the function."""
        if self._stream is None:
            self.start()
        if not self._stream["ended"]:
            self._stream["ended"] = True
            self._frame({"type": "end"})
        return {"body": "", "statusCode": self._stream["statusCode"], "headers": self._stream["headers"]}

    def send(self, body="", status_code=200, headers=None):
        return {"body": str(body), "statusCode": status_code, "headers": headers or {}}

    def text(self, body="", status_code=200, headers=None):
        return {"body": str(body), "statusCode": status_code, "headers": {"content-type": "text/plain", **(headers or {})}}

    def json(self, obj, status_code=200, headers=None):
        return {"body": json.dumps(obj), "statusCode": status_code, "headers": {"content-type": "application/json", **(headers or {})}}

    def binary(self, data, status_code=200, headers=None):
        return {"body": bytes(data).decode("latin-1"), "statusCode": status_code, "headers": headers or {}}

    def empty(self):
        return {"body": "", "statusCode": 204, "headers": {}}

    def redirect(self, url, status_code=301, headers=None):
        return {"body": "", "statusCode": status_code, "headers": {"location": url, **(headers or {})}}


class Context:
    def __init__(self, data, logs, errors, out=None):
        self.req = Request(data)
        self.res = Response(out)
        self._logs = logs
        self._errors = errors

    def log(self, *args):
        self._logs.append(" ".join(a if isinstance(a, str) else repr(a) for a in args))

    def error(self, *args):
        self._errors.append(" ".join(a if isinstance(a, str) else repr(a) for a in args))


PACKAGES_DIR = ".python_packages"


def add_import_paths(entry):
    root = os.getcwd()
    # Inserted lowest priority first, so the function's own files win.
    for path in (os.path.join(root, PACKAGES_DIR), root, os.path.dirname(os.path.abspath(entry))):
        if path in sys.path:
            sys.path.remove(path)
        sys.path.insert(0, path)


def main():
    entry = sys.argv[1]
    add_import_paths(entry)
    data = json.loads(sys.stdin.read())
    logs, errors = [], []
    real_stdout = sys.stdout
    context = Context(data, logs, errors, real_stdout)
    captured = io.StringIO()
    threw = False
    try:
        spec = importlib.util.spec_from_file_location("bunwrite_function", entry)
        module = importlib.util.module_from_spec(spec)
        with contextlib.redirect_stdout(captured):
            spec.loader.exec_module(module)
            result = module.main(context)
            if inspect.iscoroutine(result):
                result = asyncio.run(result)
        if context.res._stream is not None:
            out = context.res.end()
        else:
            out = result if isinstance(result, dict) and "statusCode" in result else context.res.empty()
    except Exception:
        threw = True
        errors.append(traceback.format_exc())
        out = {"body": "", "statusCode": 500, "headers": {}}
    stream = context.res._stream
    # A streamed response already sent its status and body; `failed` tells the
    # server whether it finished or broke off with an error.
    if stream is not None:
        out = {"body": "", "statusCode": stream["statusCode"], "headers": stream["headers"], "streamed": True, "failed": threw and not stream["ended"]}
    if captured.getvalue():
        logs.insert(0, captured.getvalue().rstrip())
    out.update({"logs": "\n".join(logs), "errors": "\n".join(errors)})
    real_stdout.write("\n" + RESULT_MARKER + json.dumps(out) + "\n")
    real_stdout.flush()


if __name__ == "__main__":
    main()
