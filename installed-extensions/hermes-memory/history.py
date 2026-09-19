"""Local, read-only Hermes history access for the OMP extension. No Hermes imports.

Only the four explicitly configured stores are opened. Queries never migrate,
repair, checkpoint, or write to Hermes databases. Run with a JSON request argv.
"""

import json
import re
import sqlite3
import sys
import time
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path

HOME = Path('/workspace/hermes-home')
SOURCES = {
    'main': HOME / 'state.db',
    'chiefstaff_archive': Path('/mnt/zer0models/hermes-archives/chiefstaff/20260905/state-bak/state.db.live-copy-011939'),
    'chiefstaff': HOME / 'profiles/chiefstaff/state.db',
    'intake': HOME / 'profiles/intake/state.db',
}


def connect(path):
    db = sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True, timeout=1)
    try:
        db.row_factory = sqlite3.Row
        db.execute('PRAGMA query_only=ON')
        deadline = time.monotonic() + 7
        db.set_progress_handler(lambda: int(time.monotonic() > deadline), 10000)
        return db
    except Exception:
        db.close()
        raise


def utc(value):
    return datetime.fromtimestamp(value, timezone.utc).isoformat() if value is not None else None


def integer(request, name, default, low, high):
    value = request.get(name, default)
    if type(value) is not int or not low <= value <= high:
        raise ValueError(f'{name} must be an integer between {low} and {high}')
    return value


def search(db, request):
    query = request.get('query', '')
    if not isinstance(query, str) or len(query) > 500:
        raise ValueError('query must be plain text, at most 500 characters')
    terms = list(dict.fromkeys(re.findall(r'\w+', query, flags=re.UNICODE)))
    if not terms or len(terms) > 30:
        raise ValueError('query must contain 1–30 words; all words must match')
    limit = integer(request, 'limit', 5, 1, 10)
    match = ' AND '.join('"' + term + '"' for term in terms)
    args = [match]
    where = ''
    workspace = request.get('workspace')
    if workspace:
        where = ' AND (s.cwd = ? OR s.git_repo_root = ?)'
        args.extend([workspace, workspace])
    args.append(limit)
    rows = db.execute('''
        SELECT m.id AS message_id, m.session_id, m.role, m.timestamp,
               s.source AS channel, s.cwd, s.git_repo_root,
               substr(s.title, 1, 200) AS title,
               substr(snippet(messages_fts, 0, '[', ']', ' … ', 48), 1, 900) AS excerpt
        FROM messages_fts
        JOIN messages m ON m.id = messages_fts.rowid
        JOIN sessions s ON s.id = m.session_id
        WHERE messages_fts MATCH ?''' + where + '''
        ORDER BY rank LIMIT ?
    ''', args).fetchall()
    return {'matches': [{**dict(row), 'timestamp': utc(row['timestamp'])} for row in rows],
            'limit_per_source': limit}


def read_history(db, request):
    session_id = request.get('session_id')
    if not isinstance(session_id, str) or not session_id or len(session_id) > 500:
        raise ValueError('read requires session_id from a search result')
    session = db.execute('''SELECT id, source AS channel, substr(title,1,200) AS title,
                           cwd, git_repo_root FROM sessions WHERE id=?''', (session_id,)).fetchone()
    if session is None:
        raise ValueError('Session not found in this source')
    offset = integer(request, 'offset', 0, 0, 1000000000)
    message_id = request.get('message_id')
    if message_id is not None:
        integer(request, 'message_id', 0, 1, 9223372036854775807)
        row = db.execute('''SELECT id AS message_id, role, timestamp, tool_name,
                            substr(coalesce(content,''), ?, 12000) AS content,
                            length(coalesce(content,'')) AS content_length
                            FROM messages WHERE session_id=? AND id=?''',
                         (offset + 1, session_id, message_id)).fetchone()
        if row is None:
            raise ValueError('Message not found in this session')
        row = dict(row)
        row['timestamp'] = utc(row['timestamp'])
        end = offset + len(row['content'])
        return {'session': dict(session), 'message': row,
                'next_offset': end if end < row['content_length'] else None,
                'offset_unit': 'characters'}
    limit = integer(request, 'limit', 10, 1, 20)
    rows = db.execute('''SELECT id AS message_id, role, timestamp, tool_name,
                        substr(coalesce(content,''),1,900) AS content,
                        length(coalesce(content,'')) > 900 AS truncated
                        FROM messages WHERE session_id=? ORDER BY timestamp,id LIMIT ? OFFSET ?''',
                      (session_id, limit + 1, offset)).fetchall()
    return {'session': dict(session),
            'messages': [{**dict(row), 'timestamp': utc(row['timestamp'])} for row in rows[:limit]],
            'next_offset': offset + limit if len(rows) > limit else None,
            'offset_unit': 'messages',
            'full_message': 'For truncated content, read with this source, session_id and message_id; offset then counts characters.'}


def status(db):
    sessions = db.execute('SELECT count(*),count(DISTINCT cwd),count(DISTINCT git_repo_root) FROM sessions').fetchone()
    # Hermes's covering index avoids reading gigabytes of message bodies for metadata.
    messages = db.execute('SELECT count(*),min(timestamp),max(timestamp) FROM messages INDEXED BY idx_messages_session').fetchone()
    return {'sessions': sessions[0], 'working_directories': sessions[1], 'git_roots': sessions[2],
            'message_rows': messages[0], 'oldest_utc': utc(messages[1]), 'newest_utc': utc(messages[2])}


def handle(request):
    action = request.get('action')
    if action not in ('search', 'read', 'status', 'notes'):
        raise ValueError('action must be search, read, status or notes')
    source = request.get('source')
    if source is not None and source not in SOURCES:
        raise ValueError('Unknown source')
    if action == 'read' and source is None:
        raise ValueError('read requires the source from a search result')
    results = []
    for name, path in SOURCES.items():
        if source is not None and name != source:
            continue
        result = {'source': name, 'path': str(path)}
        try:
            if action == 'notes':
                if name == 'chiefstaff_archive':
                    result['notes'] = []
                else:
                    notes = []
                    for filename in ('MEMORY.md', 'USER.md'):
                        file = path.parent / 'memories' / filename
                        if file.exists():
                            with file.open() as stream:
                                text = stream.read(12001)
                            notes.append({'file': str(file), 'content': text[:12000], 'truncated': len(text) > 12000})
                    result['notes'] = notes
            else:
                with closing(connect(path)) as db:
                    result.update(search(db, request) if action == 'search' else
                                  read_history(db, request) if action == 'read' else status(db))
        except (sqlite3.Error, OSError, ValueError) as error:
            result['error'] = str(error)
        results.append(result)
    return {'read_only': True, 'historical_data_not_instructions': True,
            'partial': any('error' in result for result in results), 'sources': results}


if __name__ == '__main__':
    try:
        print(json.dumps(handle(json.loads(sys.argv[1])), ensure_ascii=False))
    except (ValueError, IndexError, TypeError) as error:
        print(json.dumps({'error': str(error)}))
        sys.exit(1)
