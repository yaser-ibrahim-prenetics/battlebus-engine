#!/usr/bin/env python3
"""Prepare and verify selective releases. Never pushes, merges, or deploys."""
import argparse
import json
import os
import pathlib
import re
import subprocess
import tempfile

MANIFEST = '.release/selection.json'

def git(*args, cwd=None):
    return subprocess.check_output(['git', '-c', 'core.hooksPath=/dev/null',
        '-c', 'user.name=Release automation', '-c', 'user.email=release@users.noreply.github.com',
        *args], cwd=cwd, text=True).strip()

def resolve(value):
    if not re.fullmatch(r'[0-9a-fA-F]{7,40}', value):
        raise ValueError('Expected a commit SHA: ' + value)
    return git('rev-parse', '--verify', value + '^{commit}')

def selected(base, source, values):
    commits = [resolve(value.strip()) for value in values.split(',')]
    if not 1 <= len(commits) <= 50 or len(set(commits)) != len(commits):
        raise ValueError('Select 1–50 distinct commits in application order')
    for sha in commits:
        git('merge-base', '--is-ancestor', sha, source)
        if len(git('rev-list', '--parents', '-n', '1', sha).split()) != 2:
            raise ValueError('Select underlying commits, not merge/root commits')
        if subprocess.run(['git', 'merge-base', '--is-ancestor', sha, base]).returncode == 0:
            raise ValueError('Commit already belongs to main: ' + sha)
        if MANIFEST in git('diff-tree', '--no-commit-id', '--name-only', '-r', sha).splitlines():
            raise ValueError('Selected commits cannot change the release manifest')
    return commits

def prepare(source, values, branch):
    git('check-ref-format', '--branch', source)
    git('check-ref-format', '--branch', branch)
    if source == 'main' or not branch.startswith('release/selective-'):
        raise ValueError('Use a non-main source and a release/selective-* destination')
    if git('status', '--porcelain'):
        raise ValueError('A clean checkout is required')
    git('fetch', 'origin', '+refs/heads/main:refs/remotes/origin/main',
        f'+refs/heads/{source}:refs/remotes/origin/{source}')
    base = git('rev-parse', 'origin/main')
    commits = selected(base, 'origin/' + source, values)
    git('switch', '-c', branch, base)
    try:
        for sha in commits:
            git('cherry-pick', '-x', sha)
    except subprocess.CalledProcessError:
        subprocess.run(['git', 'cherry-pick', '--abort'], check=False)
        raise ValueError('Cherry-pick failed; resolve dependencies in the source branch and retry')
    data = dict(schemaVersion=1, baseCommit=base, sourceBranch=source,
        sourceCommits=commits, repository=os.environ['GITHUB_REPOSITORY'])
    path = pathlib.Path(MANIFEST)
    path.parent.mkdir(exist_ok=True)
    path.write_text(json.dumps(data, indent=2) + '\n')
    git('add', MANIFEST)
    git('commit', '-m', 'chore: record selected release commits')
    return data

def verify(target='HEAD', expected_base=None):
    data = json.loads(git('show', f'{target}:{MANIFEST}'))
    if data.get('schemaVersion') != 1 or data.get('repository') != os.environ['GITHUB_REPOSITORY']:
        raise ValueError('Invalid release provenance')
    base = resolve(data['baseCommit'])
    if expected_base and base != expected_base:
        raise ValueError('Main has changed. Prepare a new release from the current main commit')
    git('merge-base', '--is-ancestor', base, target)
    source = 'refs/remotes/origin/' + data['sourceBranch']
    git('check-ref-format', source)
    commits = selected(base, source, ','.join(data['sourceCommits']))
    # Replay the selection independently. Comparing trees catches unrelated edits,
    # stale manifests, and conflict resolutions that silently add extra changes.
    with tempfile.TemporaryDirectory(prefix='selective-release-') as tmp:
        checkout = str(pathlib.Path(tmp) / 'replay')
        git('worktree', 'add', '--detach', checkout, base)
        try:
            for sha in commits:
                git('cherry-pick', '-x', sha, cwd=checkout)
            replay = git('rev-parse', 'HEAD', cwd=checkout)
            git('diff', '--exit-code', replay, target, '--', '.', ':(exclude)' + MANIFEST)
        finally:
            git('worktree', 'remove', '--force', checkout)
    return data

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    create = commands.add_parser('prepare')
    create.add_argument('--source', required=True)
    create.add_argument('--commits', required=True)
    create.add_argument('--branch', required=True)
    check = commands.add_parser('verify')
    check.add_argument('--target', default='HEAD')
    check.add_argument('--expected-base')
    args = parser.parse_args()
    try:
        result = prepare(args.source, args.commits, args.branch) if args.command == 'prepare' else verify(args.target, args.expected_base)
        print(json.dumps(result, indent=2))
    except (ValueError, KeyError, subprocess.CalledProcessError) as error:
        parser.exit(1, f'Selective release rejected: {error}\n')
