#!/usr/bin/env python3
"""Serve Sinkful and save its data to disk, so progress survives across browsers and sessions.

    python3 server.py              # http://localhost:5173, data in ./data/
    python3 server.py 8080         # another port
    python3 server.py 5175 --data /tmp/sinkful-test   # separate data folder (e.g. for testing)

Endpoints (localhost only):
    GET  /api/state    -> {"tasks": [...], "deleted": {...}, "rev": n}, or {"tasks": null, "rev": 0} if nothing saved yet
    PUT  /api/state    <- {"tasks": [...], "deleted": {...}, "baseRev": n}
                       -> 200 {"rev": n+1}, or 409 with the current state if baseRev is stale
                          (another tab saved first; the client merges and retries)
    POST /api/history  <- {"type": "...", ...}        appends a line to data/history.jsonl

Before overwriting data/sinkful.json, a copy goes to data/backups/ (at most one every 5 minutes, newest 100 kept).
"""
import json
import os
import shutil
import threading
import sys
import tempfile
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
MAX_BODY = 5 * 1024 * 1024
BACKUP_EVERY = 5 * 60  # seconds
BACKUP_KEEP = 100


def parse_args(argv):
    port, data = 5173, os.path.join(ROOT, 'data')
    args = list(argv)
    if '--data' in args:
        i = args.index('--data')
        data = os.path.abspath(args[i + 1])
        del args[i:i + 2]
    if args:
        port = int(args[0])
    return port, data


PORT, DATA = parse_args(sys.argv[1:])
STATE = os.path.join(DATA, 'sinkful.json')
HISTORY = os.path.join(DATA, 'history.jsonl')
BACKUPS = os.path.join(DATA, 'backups')
LOCK = threading.Lock()  # one writer at a time


def read_state():
    try:
        with open(STATE, encoding='utf-8') as f:
            return json.load(f)
    except FileNotFoundError:
        return None


def backup_state():
    """Snapshot the current file before it's replaced (rate-limited, oldest pruned)."""
    if not os.path.exists(STATE):
        return
    os.makedirs(BACKUPS, exist_ok=True)
    names = sorted(n for n in os.listdir(BACKUPS) if n.startswith('sinkful-') and n.endswith('.json'))
    if names and time.time() - os.path.getmtime(os.path.join(BACKUPS, names[-1])) < BACKUP_EVERY:
        return
    shutil.copyfile(STATE, os.path.join(BACKUPS, time.strftime('sinkful-%Y%m%d-%H%M%S.json')))
    for old in names[:max(0, len(names) + 1 - BACKUP_KEEP)]:
        os.remove(os.path.join(BACKUPS, old))


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def log_message(self, fmt, *args):
        if self.path.startswith('/api/') and self.command != 'GET':
            return  # saves happen constantly; keep the console readable
        super().log_message(fmt, *args)

    def send_json(self, status, payload=None):
        body = b'' if payload is None else json.dumps(payload).encode()
        self.send_response(status)
        if body:
            self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        length = int(self.headers.get('Content-Length') or 0)
        if length <= 0 or length > MAX_BODY:
            return None
        try:
            return json.loads(self.rfile.read(length))
        except ValueError:
            return None

    def do_GET(self):
        if self.path == '/api/state':
            try:
                return self.send_json(200, read_state() or {'tasks': None, 'rev': 0})
            except ValueError:
                return self.send_json(500, {'error': f'{STATE} is not valid JSON'})
        if self.path.startswith('/data/'):
            return self.send_error(404)  # data goes through the API only
        return super().do_GET()

    def do_PUT(self):
        if self.path != '/api/state':
            return self.send_error(404)
        body = self.read_json()
        if not isinstance(body, dict) or not isinstance(body.get('tasks'), list):
            return self.send_json(400, {'error': 'expected {"tasks": [...]}'})
        with LOCK:
            current = read_state() or {}
            rev = current.get('rev', 0)
            base = body.pop('baseRev', None)
            if base is not None and base != rev and current.get('tasks') is not None:
                return self.send_json(409, current)  # someone else saved since this client last synced
            os.makedirs(DATA, exist_ok=True)
            backup_state()
            body['rev'] = rev + 1
            body['savedAt'] = time.strftime('%Y-%m-%dT%H:%M:%S%z')
            # Write to a temp file and swap it in, so a crash never leaves half a file.
            fd, tmp = tempfile.mkstemp(dir=DATA, suffix='.tmp')
            with os.fdopen(fd, 'w', encoding='utf-8') as f:
                json.dump(body, f, indent=2)
            os.replace(tmp, STATE)
        return self.send_json(200, {'rev': body['rev']})

    def do_POST(self):
        if self.path != '/api/history':
            return self.send_error(404)
        event = self.read_json()
        if not isinstance(event, dict) or not isinstance(event.get('type'), str):
            return self.send_json(400, {'error': 'expected {"type": ...}'})
        event.setdefault('at', time.strftime('%Y-%m-%dT%H:%M:%S%z'))
        os.makedirs(DATA, exist_ok=True)
        with open(HISTORY, 'a', encoding='utf-8') as f:
            f.write(json.dumps(event) + '\n')
        return self.send_json(204)


if __name__ == '__main__':
    server = ThreadingHTTPServer(('127.0.0.1', PORT), Handler)
    print(f'Sinkful on http://localhost:{PORT}  (data: {DATA})')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
