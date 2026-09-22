"""Release isolation and reproducibility tests using synthetic public fixtures."""
from pathlib import Path
import hashlib
import importlib.util
import json
import os
import subprocess
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location('framekeep_package', Path(__file__).parents[1] / 'scripts' / 'package_source.py')
package = importlib.util.module_from_spec(spec)
spec.loader.exec_module(package)

class InstallationPackageTests(unittest.TestCase):
    @unittest.skipUnless(os.name == 'nt', 'Windows PowerShell validation')
    def test_hashing_does_not_depend_on_module_search_path(self):
        helper = str(Path(__file__).parents[1] / 'scripts' / 'Install-Common.ps1').replace("'", "''")
        fixture = Path(__file__).resolve()
        escaped = str(fixture).replace("'", "''")
        environment = os.environ.copy(); environment['PSModulePath'] = ''
        executable = Path(os.environ['WINDIR']) / 'System32/WindowsPowerShell/v1.0/powershell.exe'
        result = subprocess.run([str(executable),'-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass',
                                 '-Command',f". '{helper}'; Get-FramekeepSha256 '{escaped}'"],
                                env=environment,capture_output=True,text=True)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(result.stdout.strip().lower(),hashlib.sha256(fixture.read_bytes()).hexdigest())

    @unittest.skipUnless(os.name == 'nt', 'Windows reparse-tag validation')
    def test_cloud_reparse_tags_never_allow_name_surrogates(self):
        helper = str(Path(__file__).parents[1] / 'scripts' / 'Install-Common.ps1').replace("'", "''")
        script = f". '{helper}'; " + r"""
        foreach ($tag in @('9000001A','9000601A','9000F01A')) {
            if (-not (Test-FramekeepCloudTag ([Convert]::ToUInt32($tag,16)))) { throw 'Cloud placeholder rejected' }
        }
        foreach ($tag in @('A000000C','A0000003','8000001B','90000000')) {
            if (Test-FramekeepCloudTag ([Convert]::ToUInt32($tag,16))) { throw 'Unsafe reparse tag accepted' }
        }
        function Get-Item { [pscustomobject]@{LinkType='SymbolicLink';Target='untrusted';Attributes=[IO.FileAttributes]::ReparsePoint} }
        try { Assert-FramekeepSourceFile 'synthetic-link'; throw 'Link was accepted' }
        catch { if ($_.Exception.Message -ne 'Linked source file refused.') { throw } }
        exit 0
        """
        result = subprocess.run(['powershell.exe','-NoProfile','-NonInteractive','-Command',script],capture_output=True,text=True)
        self.assertEqual(result.returncode,0,result.stderr)

    def fixture(self, root):
        entries = {
            'package.json': json.dumps({'version': '1.8.0-beta.1'}),
            'extension/manifest.json': json.dumps({'version': '1.8.0'}),
            'README.md': 'Synthetic Framekeep fixture', 'LICENSE': 'Synthetic test license',
            'THIRD_PARTY_NOTICES.md': 'Synthetic notices', 'extension/desktop.html': '<!doctype html>',
            'extension/desktop.js': 'export {};', 'extension/popup.js': 'export {};',
            'native/host.py': '# fixture', 'scripts/Install.ps1': '# fixture',
        }
        required = ('Install Framekeep.cmd', *(f'extension/{p}' for p in package.EXTENSION),
                    *(f'extension/icons/{p}' for p in package.ICONS),
                    *(f'native/{p}' for p in package.NATIVE), *(f'scripts/{p}' for p in package.SCRIPTS))
        for name in required: entries.setdefault(name, 'synthetic fixture')
        for name, content in entries.items():
            target = root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content, encoding='utf-8')
        return entries

    def test_only_exact_public_files_are_selected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            expected = self.fixture(root)
            for name in ('unrelated-product/private.json','reports/chat.md','native/browser-sources/session.bin',
                         'extension/user-data.json','native/config.json','scripts/private.ps1',
                         '.git/config','tests/live-private.py','PRIVATE_WORKSPACE_STATE.json'):
                target = root / name; target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text('SECRET TEST SENTINEL', encoding='utf-8')
            self.assertEqual(set(package.public_files(root)), set(expected))

    def test_missing_license_fails_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); self.fixture(root); (root / 'LICENSE').unlink()
            with self.assertRaisesRegex(ValueError, 'LICENSE'): package.public_files(root)

    def test_public_ignore_replaces_private_controls_without_editing_source(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'source'; root.mkdir(); self.fixture(root)
            private = root / '.gitignore'; private.write_text('PRIVATE_CONTROL_MARKER.json\n',encoding='utf-8')
            stage = Path(directory) / 'stage'
            package.main([str(root),'--stage',str(stage)])
            self.assertEqual(private.read_text('utf-8'),'PRIVATE_CONTROL_MARKER.json\n')
            self.assertEqual((stage / '.gitignore').read_text('utf-8'),package.PUBLIC_GITIGNORE)
            self.assertNotIn('PRIVATE_CONTROL_MARKER',(stage / '.gitignore').read_text('utf-8'))

    def test_archives_are_reproducible_and_hash_every_member(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'source'; root.mkdir(); self.fixture(root)
            one, two = Path(directory) / 'one', Path(directory) / 'two'
            package.main([str(root), '--output', str(one)])
            package.main([str(root), '--output', str(two)])
            for path in one.iterdir():
                self.assertEqual(path.read_bytes(), (two / path.name).read_bytes())
                if path.suffix != '.zip': continue
                with zipfile.ZipFile(path) as archive:
                    manifest = json.loads(archive.read('SOURCE_MANIFEST.json'))['sha256']
                    self.assertEqual(set(manifest), set(archive.namelist()) - {'SOURCE_MANIFEST.json'})
                    for member, sha in manifest.items():
                        self.assertEqual(hashlib.sha256(archive.read(member)).hexdigest(), sha)
                    if 'extension.zip' in path.name:
                        self.assertIn('LICENSE', archive.namelist())
                        self.assertIn('manifest.json', archive.namelist())
                        self.assertNotIn('desktop.html', archive.namelist())

    def test_stage_is_clean_and_refuses_overwrite(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'source'; root.mkdir(); expected = self.fixture(root)
            stage = Path(directory) / 'stage'
            package.main([str(root), '--stage', str(stage)])
            self.assertEqual({str(p.relative_to(stage)).replace('\\','/') for p in stage.rglob('*') if p.is_file()},set(expected))
            with self.assertRaisesRegex(ValueError, 'empty'): package.main([str(root), '--stage', str(stage)])

    def test_version_mismatch_refuses_release(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); self.fixture(root)
            (root / 'extension/manifest.json').write_text('{"version":"1.7.2"}', encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'versions'): package.main([str(root)])

if __name__ == '__main__': unittest.main()
