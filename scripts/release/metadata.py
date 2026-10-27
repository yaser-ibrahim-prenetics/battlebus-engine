"""Emit allowlisted provenance for the exact checkout used by the build."""
import json
import os
import pathlib
import re
import subprocess

def metadata():
    sha = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()
    if os.getenv('GITHUB_SHA') and sha != os.environ['GITHUB_SHA']:
        raise ValueError('Build checkout differs from the workflow commit')
    repo = os.environ['GITHUB_REPOSITORY']
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repo):
        raise ValueError('Invalid repository')
    path = pathlib.Path('.release/selection.json')
    selection = json.loads(path.read_text()) if path.exists() and os.getenv('SELECTIVE_RELEASE_ENABLED') == 'true' else {}
    commits = selection.get('sourceCommits', [])
    if not isinstance(commits, list) or len(commits) > 50 or any(not re.fullmatch(r'[0-9a-f]{40}', s) for s in commits):
        raise ValueError('Invalid selected commits')
    return {'RELEASE_COMMIT': sha, 'RELEASE_REPOSITORY': repo,
        'RELEASE_SOURCE_COMMITS': json.dumps(commits, separators=(',', ':')),
        'RELEASE_RUN_URL': f'https://github.com/{repo}/actions/runs/{os.environ["GITHUB_RUN_ID"]}',
        'RELEASE_MODE': 'selective' if commits else 'main'}

if __name__ == '__main__':
    print(json.dumps(metadata()))
