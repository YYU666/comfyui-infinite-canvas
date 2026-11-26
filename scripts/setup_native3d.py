"""Create an isolated optional CPU Native3D runtime. Never modifies host Python."""
import argparse
from pathlib import Path
import subprocess
import sys
import venv

if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--venv', required=True)
    args = p.parse_args()
    target = Path(args.venv).resolve()
    if target.exists() and not (target / 'pyvenv.cfg').exists():
        p.error('Target exists and is not a virtual environment')
    venv.EnvBuilder(with_pip=True).create(target)
    exe = target / ('Scripts/python.exe' if sys.platform == 'win32' else 'bin/python')
    subprocess.run([str(exe), '-X', 'utf8', '-m', 'pip', 'install', '-r', str(Path(__file__).resolve().parents[1] / 'requirements-native3d.txt')], check=True)
    print(exe)
