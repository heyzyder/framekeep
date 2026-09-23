"""Deterministic, allowlisted Framekeep releases; no private history or runtime data.

Run from any directory: python scripts/package_source.py SOURCE --output OUTPUT.
Use --stage EMPTY_DIRECTORY to prepare a reviewable public tree without Git history.
"""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
import re
import zipfile

TOP = ('package.json', 'README.md', 'LICENSE', 'ATTRIBUTION.md', 'THIRD_PARTY_NOTICES.md',
       'CONTRIBUTING.md', 'SECURITY.md', 'CHANGELOG.md', '.gitignore', '.gitattributes', 'Install Framekeep.cmd')
EXTENSION = ('background.js', 'capture-discovery.js', 'capture-worker.js', 'design.css',
             'floating.css', 'floating.js', 'frame-media.js', 'manifest.json', 'page-media.js',
             'page-transcripts.js', 'popup.css', 'popup.html', 'popup.js', 'shared.js',
             'transport.js', 'ui-icons.js', 'view.js', 'youtube-transcript.js',
             'desktop.html', 'desktop.css', 'desktop.js', 'desktop-model.js', 'widget-visibility.js',
             'browser-transcript-worker.js', 'browser-transcript-ui.js', 'browser-transcript.html',
             'browser-transcript.css', 'browser-transcript-panel.js', 'browser-audio.html',
             'browser-audio.js', 'browser-audio-worklet.js')
ICONS = ('icon16.png', 'icon32.png', 'icon48.png', 'icon128.png', 'framekeep.ico', 'framekeep-app.ico')
NATIVE = ('host.py', 'desktop.pyw', 'desktop_bridge.py', 'windows_identity.py', 'recycle.py',
          'page_source.py', 'browser_sources.py', 'media_capture.py', 'podcast_audio.py',
          'wrapped_hls.py', 'platforms.json', 'launcher.cs', 'library_state.py', 'media_preview.py',
          'study_adapter.py', 'browser_transcription.py', 'streaming_engine.py', 'framekeep_cli.py', 'framekeep_mcp.py')
SCRIPTS = ('Install.ps1', 'Install-Common.ps1', 'Uninstall.ps1', 'Update-Installed.ps1',
           'Build-Launcher.ps1', 'Package.ps1', 'Build-Beta.ps1', 'package_source.py', 'check.mjs')
DOCS = ('installation.md', 'architecture.md', 'limitations.md')
SCREENSHOTS = ('desktop-library.png', 'desktop-activity.png', 'desktop-settings.png',
               'desktop-workspace.png', 'extension-capture.png', 'before-desktop.png', 'before-extension.png')
TESTS = ('background.test.js', 'capture-worker.test.js', 'frame-media.test.js', 'page-media.test.js',
         'page-transcripts.test.js', 'shared.test.js', 'youtube-intake.test.js', 'desktop_test.py',
         'media_capture_test.py', 'native_test.py', 'page_source_test.py', 'podcast_audio_test.py',
         'wrapped_hls_test.py', 'installation_test.py', 'beta_backend_test.py', 'beta_capture_test.py',
         'desktop-model.test.js', 'desktop-ui.test.js', 'widget-visibility.test.js', 'journeys_backend_test.py',
         'browser-transcript-worker.test.js', 'browser-audio.test.js', 'browser_transcription_test.py')
PUBLIC_GITIGNORE = '''# Generated files and local application data
__pycache__/
*.py[cod]
node_modules/
dist/
.venv/
*.log
config.json
desktop-settings.json
desktop-health.json
host-manifest.json
framekeep-install.json
launcher.json
launcher-build.json
native/browser-sources/
.framekeep/
'''

def public_bytes(root, relative):
    # The private checkout's ignore file can name private workspace controls.
    # Public exports use this generic, deterministic runtime-only ignore file.
    return PUBLIC_GITIGNORE.encode('utf-8') if relative == '.gitignore' else (root / relative).read_bytes()

def allowed_names():
    return (*TOP, *(f'extension/{p}' for p in EXTENSION), *(f'extension/icons/{p}' for p in ICONS),
            *(f'native/{p}' for p in NATIVE), *(f'scripts/{p}' for p in SCRIPTS),
            *(f'tests/{p}' for p in TESTS), *(f'docs/{p}' for p in DOCS),
            *(f'docs/screenshots/{p}' for p in SCREENSHOTS))

def public_files(root):
    """Select only exact code/doc names; never enumerate the private workspace."""
    root = Path(root).resolve()
    files = []
    for relative in allowed_names():
        path = root / relative
        if path.is_symlink():
            raise ValueError(f'Symlink refused: {relative}')
        if path.is_file():
            if not path.resolve().is_relative_to(root):
                raise ValueError(f'Escaping source refused: {relative}')
            files.append(relative)
    required = ('package.json', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'Install Framekeep.cmd',
                *(f'extension/{p}' for p in EXTENSION), *(f'extension/icons/{p}' for p in ICONS),
                *(f'native/{p}' for p in NATIVE), *(f'scripts/{p}' for p in SCRIPTS))
    missing = set(required) - set(files)
    if missing:
        raise ValueError('Missing public source requirements: ' + ', '.join(sorted(missing)))
    return sorted(files)

def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def archive(root, destination, files, strip=''):
    with zipfile.ZipFile(destination, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as output:
        for relative in files:
            name = relative.removeprefix(strip)
            entry = zipfile.ZipInfo(name, (2026, 1, 1, 0, 0, 0))
            entry.compress_type = zipfile.ZIP_DEFLATED
            entry.external_attr = 0o100644 << 16
            output.writestr(entry, public_bytes(root, relative))
        manifest = {p.removeprefix(strip): hashlib.sha256(public_bytes(root,p)).hexdigest() for p in files}
        entry = zipfile.ZipInfo('SOURCE_MANIFEST.json', (2026, 1, 1, 0, 0, 0))
        entry.compress_type = zipfile.ZIP_DEFLATED
        entry.external_attr = 0o100644 << 16
        output.writestr(entry, json.dumps({'sha256': manifest}, indent=2) + '\n')
    with zipfile.ZipFile(destination) as check:
        if check.testzip():
            raise ValueError('Release archive integrity failed')

def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--stage', type=Path)
    parser.add_argument('--list', action='store_true')
    args = parser.parse_args(argv)
    root = args.source.resolve()
    files = public_files(root)
    if args.list:
        print('\n'.join(files))
        return
    version = json.loads((root / 'package.json').read_text('utf-8-sig'))['version']
    if not re.fullmatch(r'\d+\.\d+\.\d+(?:-[a-zA-Z0-9.]+)?', version):
        raise ValueError('Unsafe release version')
    extension_version = json.loads((root / 'extension/manifest.json').read_text('utf-8-sig'))['version']
    if extension_version != version.split('-')[0]:
        raise ValueError('Package and extension versions do not match')
    if args.stage:
        stage = args.stage.absolute()
        if stage.is_symlink() or stage == root or (stage.exists() and any(stage.iterdir())):
            raise ValueError('Public stage must be a new, empty directory outside source')
        if stage.resolve().is_relative_to(root):
            raise ValueError('Public stage must be outside the private source root')
        stage.mkdir(parents=True, exist_ok=True)
        for relative in files:
            target = stage / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(public_bytes(root, relative))
        print(json.dumps({'stage': str(stage), 'version': version, 'files': len(files)}))
        return
    destination = (args.output or root / 'dist').resolve()
    destination.mkdir(parents=True, exist_ok=True)
    outputs = []
    for kind, selected, strip in (
        ('source', files, ''),
        ('windows', [p for p in files if not p.startswith(('tests/', 'docs/screenshots/'))], ''),
        ('extension', [p for p in files if p in ('LICENSE','THIRD_PARTY_NOTICES.md','ATTRIBUTION.md') or (p.startswith('extension/') and not p.split('/')[-1].startswith('desktop.'))], 'extension/')):
        target = destination / f'Framekeep-{version}-{kind}.zip'
        archive(root, target, selected, strip)
        outputs.append({'file': target.name, 'sha256': digest(target), 'bytes': target.stat().st_size})
    (destination / 'SHA256SUMS.txt').write_text(''.join(f"{o['sha256']}  {o['file']}\n" for o in outputs), encoding='utf-8')
    print(json.dumps({'version': version, 'files': len(files), 'artifacts': outputs}, indent=2))

if __name__ == '__main__':
    main()
