import json,sys,zipfile,pathlib,struct,warnings
root=pathlib.Path(sys.argv[1]);root.mkdir(parents=True,exist_ok=True)
m={'name':'Dico While · 교대 공지','manifest_version':3,'version':'0.2.42','permissions':['storage']}
for kind in ['good','traversal','symlink','duplicate','local-mismatch','permission']:
 with zipfile.ZipFile(root/f'{kind}.zip','w',zipfile.ZIP_DEFLATED) as z:
  z.writestr('manifest.json',json.dumps({**m,'permissions':['storage','tabs']} if kind=='permission' else m))
  z.writestr('background.js','new')
  if kind=='traversal': z.writestr('../escape','bad')
  if kind=='symlink':
   entry=zipfile.ZipInfo('link');entry.create_system=3;entry.external_attr=0o120777<<16;z.writestr(entry,'/tmp/escape')
  if kind=='duplicate':
   with warnings.catch_warnings():
    warnings.simplefilter('ignore');z.writestr('background.js','evil')
 if kind=='local-mismatch':
  data=bytearray((root/f'{kind}.zip').read_bytes());offset=data.index(b'manifest.json');data[offset:offset+13]=b'../evilxx.txt';(root/f'{kind}.zip').write_bytes(data)
