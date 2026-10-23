#!/usr/bin/python3
"""Acquire candidate bytes without following symlinks, hardlinks or special files.

Every path component is opened relative to a held directory descriptor using
O_NOFOLLOW. No candidate module or Git configuration is executed or imported.
"""
import base64
import hashlib
import json
import os
import stat
import sys

LIMIT_FILES = 64
LIMIT_DIRECTORIES = 64
LIMIT_FILE_BYTES = 1048576
LIMIT_TOTAL_BYTES = 8388608
SKIP_ROOT = {'.git', '.xfx-audit-owner.json', '.xfx-audit-active'}
DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW


def acquire(root):
    if not os.path.isabs(root) or os.path.normpath(root) != root or root == '/':
        raise ValueError('canonical absolute workspace required')
    parent = os.open('/', DIR_FLAGS)
    try:
        for component in root.split('/')[1:]:
            child = os.open(component, DIR_FLAGS, dir_fd=parent)
            os.close(parent)
            parent = child
        info = os.fstat(parent)
        if info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ValueError('private owned workspace required')
        files, totals = {}, {'bytes': 0, 'directories': 0}

        def walk(directory, prefix='', depth=0):
            totals['directories'] += 1
            if depth > 8 or totals['directories'] > LIMIT_DIRECTORIES:
                raise ValueError('directory limit')
            for name in sorted(os.listdir(directory)):
                if not prefix and name in SKIP_ROOT:
                    continue
                if name in {'.', '..'} or '/' in name or any(ord(c) < 32 for c in name):
                    raise ValueError('unsafe name')
                relative = prefix + name
                # O_NONBLOCK ensures a raced FIFO cannot hang before fstat.
                fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
                try:
                    before = os.fstat(fd)
                    if stat.S_ISDIR(before.st_mode):
                        walk(fd, relative + '/', depth + 1)
                        continue
                    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_uid != os.getuid():
                        raise ValueError('regular owned single-link file required')
                    if before.st_size > LIMIT_FILE_BYTES or len(files) >= LIMIT_FILES:
                        raise ValueError('file limit')
                    chunks, length = [], 0
                    while True:
                        chunk = os.read(fd, min(65536, LIMIT_FILE_BYTES + 1 - length))
                        if not chunk:
                            break
                        chunks.append(chunk)
                        length += len(chunk)
                        if length > LIMIT_FILE_BYTES:
                            raise ValueError('file grew beyond limit')
                    after = os.fstat(fd)
                    if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (
                            after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns):
                        raise ValueError('file changed during acquisition')
                    totals['bytes'] += length
                    if totals['bytes'] > LIMIT_TOTAL_BYTES:
                        raise ValueError('aggregate byte limit')
                    data = b''.join(chunks)
                    files[relative] = {'sha256': hashlib.sha256(data).hexdigest(),
                                       'base64': base64.b64encode(data).decode('ascii')}
                finally:
                    os.close(fd)
        walk(parent)
        return files
    finally:
        os.close(parent)


if __name__ == '__main__':
    try:
        if len(sys.argv) != 2:
            raise ValueError('one workspace required')
        print(json.dumps(acquire(sys.argv[1]), sort_keys=True))
    except Exception:
        # Do not echo model-controlled paths or host file contents.
        print('Candidate acquisition rejected: unsafe or changing input.', file=sys.stderr)
        sys.exit(1)
