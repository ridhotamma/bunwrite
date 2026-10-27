"""Runs one Appwrite Python function execution in its own process.

`python3 runner-python.py <entrypoint>`: request JSON on stdin, result JSON on
the last stdout line after RESULT_MARKER. Mirrors the open-runtimes `context`
(req, res, log, error) the function was written against.
"""
import asyncio
import importlib.util
import inspect
import io
import json
import sys
import traceback
import contextlib
from urllib.parse import parse_qsl

RESULT_MARKER = "__APPWRITE_EXECUTION_RESULT__"


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
        self.body_binary = data["body"].encode("utf-8")

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
    def __init__(self, data, logs, errors):
        self.req = Request(data)
        self.res = Response()
        self._logs = logs
        self._errors = errors

    def log(self, *args):
        self._logs.append(" ".join(a if isinstance(a, str) else repr(a) for a in args))

    def error(self, *args):
        self._errors.append(" ".join(a if isinstance(a, str) else repr(a) for a in args))


def main():
    entry = sys.argv[1]
    data = json.loads(sys.stdin.read())
    logs, errors = [], []
    context = Context(data, logs, errors)
    captured = io.StringIO()
    try:
        spec = importlib.util.spec_from_file_location("appwrite_function", entry)
        module = importlib.util.module_from_spec(spec)
        with contextlib.redirect_stdout(captured):
            spec.loader.exec_module(module)
            result = module.main(context)
            if inspect.iscoroutine(result):
                result = asyncio.run(result)
        out = result if isinstance(result, dict) and "statusCode" in result else context.res.empty()
    except Exception:
        errors.append(traceback.format_exc())
        out = {"body": "", "statusCode": 500, "headers": {}}
    if captured.getvalue():
        logs.insert(0, captured.getvalue().rstrip())
    out.update({"logs": "\n".join(logs), "errors": "\n".join(errors)})
    sys.stdout.write("\n" + RESULT_MARKER + json.dumps(out) + "\n")


if __name__ == "__main__":
    main()
