#!/usr/bin/env python3
"""Refresh canonical sources and shared CBM before container startup."""
import fcntl
import json
import runpy
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

session = runpy.run_path(str(Path(__file__).resolve().parents[1] / 'lane/bridge/cbm-probe.py'))['session']


def git(repo, *args):
    return subprocess.run(['git', '-C', str(repo), *args], check=True,
                          stdout=subprocess.PIPE, text=True, timeout=120).stdout.strip()


def tool(call, tool_name, **arguments):
    reply = call('tools/call', {'name': tool_name, 'arguments': arguments}, timeout=600)
    result = reply.get('structuredContent')
    if result is None:
        result = json.loads(next(c['text'] for c in reply['content'] if c.get('type') == 'text'))
    if not isinstance(result, dict) or result.get('error'):
        raise RuntimeError(f'CBM {tool_name} failed: {result}')
    return result


def sync(repo, call):
    print(f'[sync] waiting for {repo.name}', flush=True)
    with (repo / '.git/sync.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        target = json.loads((repo / '.ntkrc').read_text()).get('target_branch')
        if not isinstance(target, str) or not target or target.startswith('-') or target == 'HEAD':
            raise RuntimeError(f'{repo}/.ntkrc must set target_branch')
        git(repo, 'check-ref-format', f'refs/heads/{target}')
        if git(repo, 'status', '--porcelain'):
            raise RuntimeError(f'{repo} has local changes; startup refused')
        git(repo, 'fetch', 'origin', f'refs/heads/{target}:refs/remotes/origin/{target}')
        # Detached HEAD is safe only when it is already part of the target history.
        git(repo, 'merge-base', '--is-ancestor', 'HEAD', f'origin/{target}')
        if subprocess.run(['git', '-C', str(repo), 'show-ref', '--verify', '--quiet',
                           f'refs/heads/{target}']).returncode == 0:
            git(repo, 'checkout', target)
        else:
            git(repo, 'checkout', '-b', target, f'origin/{target}')
        git(repo, 'merge', '--ff-only', f'origin/{target}')
        sha = git(repo, 'rev-parse', 'HEAD')
        if sha != git(repo, 'rev-parse', f'origin/{target}'):
            raise RuntimeError(f'{repo} is ahead of origin/{target}; startup refused')
        project = str(repo).lstrip('/').replace('/', '-')
        # CBM indexed_at has second precision; the requested build must be newer.
        requested = int(time.time())
        time.sleep(max(0, requested + 1 - time.time()))
        print(f'[sync] {repo.name} {target} {sha[:12]}; updating shared CBM', flush=True)
        tool(call, 'index_repository', repo_path=str(repo), name=project, mode='moderate', persistence=False)
        deadline = time.monotonic() + 600
        while True:
            status = tool(call, 'index_status', project=project, format='json')
            indexed = datetime.fromisoformat((status.get('indexed_at') or '1970-01-01T00:00:00Z').replace('Z', '+00:00')).timestamp()
            if status.get('status') == 'ready' and indexed > requested:
                break
            if time.monotonic() >= deadline:
                raise RuntimeError(f'CBM refresh timed out for {repo.name}')
            time.sleep(1)
        if git(repo, 'rev-parse', 'HEAD') != sha or git(repo, 'status', '--porcelain'):
            raise RuntimeError(f'{repo} changed during CBM refresh; startup refused')
        print(f'[sync] {repo.name}: Git and shared CBM ready', flush=True)


def main(root, connector, image=None):
    root = Path(root).resolve(strict=True)
    repos = sorted(p for p in root.iterdir() if not p.is_symlink()
                   and (p / '.git').is_dir() and (p / '.ntkrc').is_file())
    if not repos:
        raise RuntimeError(f'No canonical repositories with .ntkrc under {root}')
    with session(connector, image=image) as call:
        for repo in repos:
            sync(repo, call)


if __name__ == '__main__':
    try:
        if len(sys.argv) not in (3, 4):
            raise RuntimeError('usage: safe-sync.py <source-root> <shared-cbm-connector> [lane-image]')
        main(*sys.argv[1:])
    except (OSError, ValueError, KeyError, RuntimeError, subprocess.SubprocessError) as error:
        print(f'[sync] {error}', file=sys.stderr)
        sys.exit(2)
