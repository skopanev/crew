#!/usr/bin/env python3
"""Refresh canonical sources and shared CBM before container startup."""
import fcntl
import json
import os
import runpy
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from threading import Lock
from contextlib import ExitStack
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


def sync(repo, call, configuration, optional=False):
    started = time.monotonic()
    print(f'[sync] waiting for {repo.name}', flush=True)
    with (repo / '.git/sync.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        git_started = time.monotonic()
        waited = git_started - started
        target = configuration.get('targetBranch')
        if not isinstance(target, str) or not target or target.startswith('-') or target == 'HEAD':
            raise RuntimeError(f'{repo}: configuration must set targetBranch')
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
        project = configuration['cbmProject']
        cbm_started = time.monotonic()
        print(f'[sync] {repo.name} {target} {sha[:12]}; '
              f'wait {waited:.1f}s · Git {cbm_started - git_started:.1f}s; '
              'updating shared CBM', flush=True)
        available = True
        try:
            if call is None:
                raise RuntimeError('shared CBM is unavailable')
            result = tool(call, 'index_repository', repo_path=str(repo), name=project,
                          mode='moderate', persistence=False)
            if result.get('status') != 'indexed' or result.get('project') != project:
                raise RuntimeError(f'CBM did not complete indexing {repo.name}: {result}')
            status = tool(call, 'index_status', project=project, format='json')
            if status.get('status') != 'ready' or status.get('root_path') != str(repo):
                raise RuntimeError(f'CBM is not ready for {repo.name}: {status}')
        except (OSError, RuntimeError) as error:
            if not optional:
                raise
            available = False
            print(f'[sync] {repo.name}: CBM unavailable: {error}. Continue with source reads.', flush=True)
        cbm_elapsed = time.monotonic() - cbm_started
        if git(repo, 'rev-parse', 'HEAD') != sha or git(repo, 'status', '--porcelain'):
            raise RuntimeError(f'{repo} changed during CBM refresh; startup refused')
        ready = 'Git and shared CBM ready' if available else 'Git ready. CBM skipped'
        print(f'[sync] {repo.name}: {ready} · '
              f'CBM {cbm_elapsed:.1f}s · total {time.monotonic() - started:.1f}s', flush=True)
        return available


def main(root, connector, image=None):
    root = Path(root).resolve(strict=True)
    configured = json.loads(os.environ.get('LANE_REPOSITORIES_JSON', '[]'))
    settings = {Path(item['path']).resolve(strict=True): item for item in configured}
    if not settings:
        raise RuntimeError('LANE_REPOSITORIES_JSON names no configured repositories')
    if any(not p.is_relative_to(root) or not (p / '.git').is_dir() for p in settings):
        raise RuntimeError('Configured repositories must be Git directories inside sourceRoot')
    repos = sorted(settings)
    connected = time.monotonic()
    print('[sync] connecting shared CBM', flush=True)
    optional = os.environ.get('LANE_CBM_REQUIRED', 'true') == 'false'
    available = [True]
    with ExitStack() as stack:
        try:
            if not connector:
                raise RuntimeError('no shared CBM connector')
            call = stack.enter_context(session(connector, image=image))
            print(f'[sync] shared CBM connected · init {time.monotonic() - connected:.1f}s', flush=True)
        except (OSError, RuntimeError) as error:
            if not optional:
                raise
            call, available[0] = None, False
            print(f'[sync] CBM unavailable: {error}. Continue with Git refresh.', flush=True)
        rpc_lock = Lock()
        def shared_call(*args, **kwargs):
            # One MCP stream has one request in flight. Git refresh remains parallel.
            with rpc_lock:
                if not available[0]:
                    raise RuntimeError('shared CBM is unavailable')
                try:
                    return call(*args, **kwargs)
                except (OSError, RuntimeError):
                    available[0] = False
                    raise
        with ThreadPoolExecutor(max_workers=min(4, len(repos))) as pool:
            futures = [(repo, pool.submit(sync, repo, shared_call, settings[repo], optional)) for repo in repos]
            failures = []
            for repo, future in futures:
                error = future.exception()
                if error is not None:
                    failures.append((repo, error))
                elif future.result() is False:
                    available[0] = False
    if failures:
        message = '; '.join(f'{repo.name}: {error}' for repo, error in failures)
        error_type = TimeoutError if all(isinstance(error, TimeoutError)
                                        for _, error in failures) else RuntimeError
        raise error_type(message)
    return not available[0]


if __name__ == '__main__':
    try:
        if len(sys.argv) not in (3, 4):
            raise RuntimeError('usage: safe-sync.py <source-root> <shared-cbm-connector> [lane-image]')
        # 76 means Git passed but optional CBM did not. The shell removes its agent connector.
        sys.exit(76 if main(*sys.argv[1:]) else 0)
    except (OSError, ValueError, KeyError, RuntimeError, subprocess.SubprocessError) as error:
        print(f'[sync] {error}', file=sys.stderr)
        sys.exit(75 if isinstance(error, TimeoutError) else 2)
