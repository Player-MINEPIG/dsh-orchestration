#!/usr/bin/env python3
"""Start one DSH host with private logs; stop only its verified recorded PID."""
import argparse, json, os, signal, subprocess, time
from pathlib import Path

p = argparse.ArgumentParser()
p.add_argument('action', choices=['start', 'stop'])
p.add_argument('record')
p.add_argument('--root')
p.add_argument('--pid', type=int)
a, arguments = p.parse_known_args()
record = Path(a.record)
if a.action == 'start':
    assert a.root and not record.exists()
    arguments = arguments[1:] if arguments[:1] == ['--'] else arguments
    record.parent.mkdir(parents=True, exist_ok=True)
    os.umask(0o077)
    with record.with_suffix('.log').open('xb') as log:
        process = subprocess.Popen([str(Path(a.root)/'bin/dsh'), *arguments], stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
    value = {'pid': process.pid, 'root':a.root, 'args':arguments, 'startedAt':time.time()}
    record.write_text(json.dumps(value, indent=2)+'\n')
    print(json.dumps({'pid':process.pid, 'record':str(record)}))
else:
    value = json.loads(record.read_text()) if record.exists() else {'pid':a.pid, 'root':a.root}
    assert value['pid'] and value['root']
    command = subprocess.check_output(['ps','-p',str(value['pid']),'-o','args='],text=True)
    assert str(Path(value['root'])/'runtime/node_modules/@deepseek-ai/dsh/lib/bin.js') in command
    os.kill(value['pid'], signal.SIGTERM)
    for _ in range(150):
        time.sleep(.1)
        status=subprocess.run(['ps','-p',str(value['pid']),'-o','stat='],capture_output=True,text=True)
        if status.returncode or status.stdout.strip().startswith('Z'):
            print(json.dumps({'stoppedPid':value['pid']}));break
    else: raise SystemExit('Host did not stop gracefully; inspect before proceeding')
