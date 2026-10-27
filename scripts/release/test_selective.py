import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('selective', Path(__file__).with_name('selective.py'))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
meta_spec = importlib.util.spec_from_file_location('release_metadata', Path(__file__).with_name('metadata.py'))
meta = importlib.util.module_from_spec(meta_spec)
meta_spec.loader.exec_module(meta)

class SelectiveReleaseTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.old = Path.cwd()
        self.addCleanup(os.chdir, self.old)
        self.env = patch.dict(os.environ, GITHUB_REPOSITORY='example/service')
        self.env.start(); self.addCleanup(self.env.stop)
        self.root = Path(self.temp.name)
        self.remote = self.root/'remote.git'
        release.git('init', '--bare', str(self.remote))
        self.repo = self.root/'repo'; self.repo.mkdir(); os.chdir(self.repo)
        release.git('init', '-b', 'main')
        self.commit('base.txt', 'base')
        release.git('remote', 'add', 'origin', str(self.remote))
        release.git('push', '-u', 'origin', 'main')
        release.git('switch', '-c', 'develop')
        self.one = self.commit('one.txt', 'one')
        self.unrelated = self.commit('unrelated.txt', 'not selected')
        self.two = self.commit('two.txt', 'two')
        release.git('push', '-u', 'origin', 'develop')
        release.git('switch', 'main')

    def commit(self, name, content):
        Path(name).write_text(content)
        release.git('add', name)
        release.git('commit', '-m', 'test ' + name)
        return release.git('rev-parse', 'HEAD')

    def prepare(self):
        return release.prepare('develop', self.one + ',' + self.two, 'release/selective-test')

    def test_exact_selection_and_merged_release(self):
        data = self.prepare()
        self.assertTrue(Path('one.txt').exists())
        self.assertTrue(Path('two.txt').exists())
        self.assertFalse(Path('unrelated.txt').exists())
        self.assertEqual(release.verify(expected_base=data['baseCommit']), data)
        release.git('switch', 'main')
        release.git('merge', '--no-ff', 'release/selective-test', '-m', 'release')
        self.assertEqual(release.verify(expected_base=data['baseCommit']), data)

    def test_unselected_edit_rejected(self):
        self.prepare(); self.commit('extra.txt', 'must not ship')
        with self.assertRaises(subprocess.CalledProcessError): release.verify()

    def test_stale_base_rejected(self):
        self.prepare()
        with self.assertRaises(ValueError): release.verify(expected_base=self.one)

    def test_duplicate_rejected(self):
        with self.assertRaises(ValueError): release.prepare('develop', self.one+','+self.one, 'release/selective-test')

    def test_merge_commit_rejected(self):
        release.git('switch', 'develop')
        release.git('switch', '-c', 'feature')
        self.commit('feature.txt', 'feature')
        release.git('switch', 'develop')
        release.git('merge', '--no-ff', 'feature', '-m', 'merge feature')
        merge = release.git('rev-parse', 'HEAD')
        release.git('push', 'origin', 'develop')
        release.git('switch', 'main')
        with self.assertRaises(ValueError): release.prepare('develop', merge, 'release/selective-test')

    def test_missing_dependency_rejected(self):
        release.git('switch', 'develop')
        dependent = self.commit('one.txt', 'changed after one')
        release.git('push', 'origin', 'develop')
        release.git('switch', 'main')
        with self.assertRaises(ValueError): release.prepare('develop', dependent, 'release/selective-test')
        self.assertFalse(Path('.git/CHERRY_PICK_HEAD').exists())

    def test_wrong_repository_rejected(self):
        self.prepare()
        with patch.dict(os.environ, GITHUB_REPOSITORY='other/repository'):
            with self.assertRaises(ValueError): release.verify()

    def test_invalid_sha_rejected(self):
        with self.assertRaises(ValueError): release.prepare('develop', 'HEAD;echo bad', 'release/selective-test')

    def test_metadata_does_not_reuse_selection_when_enforcement_is_off(self):
        self.prepare()
        with patch.dict(os.environ, GITHUB_RUN_ID='123', GITHUB_SHA=release.git('rev-parse', 'HEAD'), SELECTIVE_RELEASE_ENABLED='false'):
            self.assertEqual(meta.metadata()['RELEASE_SOURCE_COMMITS'], '[]')
        with patch.dict(os.environ, GITHUB_RUN_ID='123', GITHUB_SHA=release.git('rev-parse', 'HEAD'), SELECTIVE_RELEASE_ENABLED='true'):
            self.assertEqual(json.loads(meta.metadata()['RELEASE_SOURCE_COMMITS']), [self.one, self.two])

    def test_metadata_rejects_wrong_build_checkout(self):
        with patch.dict(os.environ, GITHUB_RUN_ID='123', GITHUB_SHA=self.one):
            with self.assertRaises(ValueError): meta.metadata()

if __name__ == '__main__': unittest.main()
