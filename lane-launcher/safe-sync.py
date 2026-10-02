#!/usr/bin/env python3
"""Refresh canonical sources and shared CBM before container startup."""
import fcntl
import json
import runpy
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
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
    started = time.monotonic()
    print(f'[sync] waiting for {repo.name}', flush=True)
    with (repo / '.git/sync.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        git_started = time.monotonic()
        waited = git_started - started
        target = json.loads((repo / '.ntkrc').read_text()).get('target_branch')
        if not isinstance(target, str) or not target or target.startswith('-') or target == 'HEAD':
            raise RuntimeError(f'{repo}/.ntkrc must set target_branch')
        git(repo, 'check-ref-format', f'refs/heads/{target}')
        if git(repo, 'status', '--porcelain'):
            raise RuntimeError(f'{repo} has local changes; startup refused')
        git(repo, 'fetch', 'origin', f'refs/heads/{target}:refs/remotes/origin/{target}')
        # Detached HEAD is safe only when it is already part of the target history.
        git(repo, 'merge-base', '--is-ancestor', 'HEAD', f'origin/{target}')
        current = git(repo, 'branch', '--show-current')
        if current and current != target:
            has_local = subprocess.run(
                ['git', '-C', str(repo), 'show-ref', '--verify', '--quiet',
                 f'refs/heads/{target}']).returncode == 0
            if has_local:
                git(repo, 'merge-base', '--is-ancestor', target, f'origin/{target}')
                git(repo, 'checkout', target)
            else:
                git(repo, 'checkout', '-b', target, f'origin/{target}')
        git(repo, 'merge', '--ff-only', f'origin/{target}')
        sha = git(repo, 'rev-parse', 'HEAD')
        if sha != git(repo, 'rev-parse', f'origin/{target}'):
            raise RuntimeError(f'{repo} is ahead of origin/{target}; startup refused')
        project = str(repo).lstrip('/').replace('/', '-')
        cbm_started = time.monotonic()
        print(f'[sync] {repo.name} {target} {sha[:12]}; '
              f'wait {waited:.1f}s · Git {cbm_started - git_started:.1f}s; '
              'updating shared CBM', flush=True)
        result = tool(call, 'index_repository', repo_path=str(repo), name=project,
                      mode='moderate', persistence=False)
        if result.get('status') != 'indexed' or result.get('project') != project:
            raise RuntimeError(f'CBM did not complete indexing {repo.name}: {result}')
        status = tool(call, 'index_status', project=project, format='json')
        if status.get('status') != 'ready' or status.get('root_path') != str(repo):
            raise RuntimeError(f'CBM is not ready for {repo.name}: {status}')
        cbm_elapsed = time.monotonic() - cbm_started
        if git(repo, 'rev-parse', 'HEAD') != sha or git(repo, 'status', '--porcelain'):
            raise RuntimeError(f'{repo} changed during CBM refresh; startup refused')
        print(f'[sync] {repo.name}: Git and shared CBM ready · '
              f'CBM {cbm_elapsed:.1f}s · total {time.monotonic() - started:.1f}s', flush=True)


def main(root, connector, image=None):
    root = Path(root).resolve(strict=True)
    repos = sorted(p for p in root.iterdir() if not p.is_symlink()
                   and (p / '.git').is_dir() and (p / '.ntkrc').is_file())
    if not repos:
        raise RuntimeError(f'No canonical repositories with .ntkrc under {root}')
    def refresh(repo):
        # Each worker owns its MCP stream and repository lock.
        with session(connector, image=image) as call:
            sync(repo, call)
    with ThreadPoolExecutor(max_workers=min(4, len(repos))) as pool:
        futures = [(repo, pool.submit(refresh, repo)) for repo in repos]
        failures = []
        for repo, future in futures:
            error = future.exception()
            if error is not None:
                failures.append(f'{repo.name}: {error}')
    if failures:
        raise RuntimeError('; '.join(failures))


if __name__ == '__main__':
    try:
        if len(sys.argv) not in (3, 4):
            raise RuntimeError('usage: safe-sync.py <source-root> <shared-cbm-connector> [lane-image]')
        main(*sys.argv[1:])
    except (OSError, ValueError, KeyError, RuntimeError, subprocess.SubprocessError) as error:
        print(f'[sync] {error}', file=sys.stderr)
        sys.exit(2)
