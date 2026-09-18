"""Package only runtime assets; diagnostics, backups and credentials are never globbed."""
from pathlib import Path
import json, zipfile
root = Path(__file__).resolve().parent.parent
manifest = json.loads((root / 'manifest.json').read_text())
package = json.loads((root / 'package.json').read_text())
version = manifest['version']
if version != package['version']:
    raise SystemExit('manifest/package version mismatch')
files = json.loads((root / 'release-files.json').read_text())
output = root / 'dist' / f'dico-while-{version}.zip'
output.parent.mkdir(exist_ok=True)
with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as archive:
    for name in files:
        path = (root / name).resolve()
        if not path.is_relative_to(root) or not path.is_file():
            raise SystemExit(f'Invalid release file: {name}')
        archive.write(path, name)
with zipfile.ZipFile(output) as archive:
    assert all(archive.read(name) == (root / name).read_bytes() for name in files)
print(output)
