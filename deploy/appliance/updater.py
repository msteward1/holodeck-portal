#!/usr/bin/env python3
"""Holodeck Portal appliance updater (runs on the host as root, outside the portal's container).

The portal stages a release in /data/portal/lib/updates/staged/<version>/ and writes request.json; systemd
(holodeck-updater.path) then starts this script. It trusts nothing the portal wrote:

  1. the manifest must be signed by a key in /etc/holodeck-appliance/trusted-keys/ (Ed25519, checked with openssl),
     name the requested version, be newer than the running version and allow updating from it;
  2. the image is copied to a root-only folder while its SHA-256 is computed (so it can't be swapped after the
     check), must match the manifest, and once loaded must have the image ID the manifest names;
  3. the portal is stopped, its database, keys and settings are backed up, the new image becomes "current" (the old
     one "previous"), and the portal is started;
  4. if the new version isn't healthy within five minutes, the previous image and the backed-up database are put
     back and the portal is started again ("rolled_back").

Files in the shared folder are opened relative to directory descriptors with O_NOFOLLOW, and written as a new file
renamed into place, so links planted there can't redirect a read or write to the host's own files.
Progress goes to status.json for the portal's About dialog; host.json tells the portal this updater exists and
which keys it trusts. Run without a request (at boot), it only refreshes host.json.
"""
import base64
import fcntl
import glob
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import time
from datetime import datetime, timezone

UPDATER_VERSION = '1'
LIB = '/data/portal/lib'
ETC = '/data/portal/etc'
SHARED = os.path.join(LIB, 'updates')
TRUST_DIR = '/etc/holodeck-appliance/trusted-keys'
WORK = '/var/lib/holodeck-updater'
BACKUPS = '/data/backups'
IMAGE = 'holodeck-portal'
SERVICE = 'holodeck-portal.service'
HEALTH_URL = 'http://127.0.0.1:3080/api/health'
HEALTH_TIMEOUT = 300
VERSION_RE = re.compile(r'^\d+\.\d+\.\d+$')
KEEP_BACKUPS = 5

STEPS = ['Verify the release', 'Load the new version', 'Back up the portal', 'Switch to the new version', 'Check the new version', 'Clean up']


def now():
    return datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def log(msg):
    print(f'[holodeck-updater] {msg}', flush=True)


def vtuple(v):
    return tuple(int(x) for x in v.split('.'))


def run(*args, check=True, timeout=1800, text=True, **kw):
    return subprocess.run(list(args), check=check, timeout=timeout, capture_output=True, text=text, **kw)


# --- the shared folder, without following links -------------------------------------------------------------

def open_shared_dir():
    """The shared folder as a directory descriptor; created if missing, refused if it is a link."""
    st = os.lstat(LIB)
    if not stat.S_ISDIR(st.st_mode):
        raise RuntimeError(f'{LIB} is not a directory')
    lib = os.open(LIB, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        try:
            os.mkdir('updates', 0o700, dir_fd=lib)
        except FileExistsError:
            pass
        return os.open('updates', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=lib)
    finally:
        os.close(lib)


def open_subdir(parent_fd, name):
    return os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent_fd)


def read_file(dir_fd, name, limit=1024 * 1024):
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=dir_fd)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise RuntimeError(f'{name} is not a regular file')
        data = b''
        while len(data) <= limit:
            chunk = os.read(fd, 65536)
            if not chunk:
                return data
            data += chunk
        raise RuntimeError(f'{name} is too large')
    finally:
        os.close(fd)


def write_json(dir_fd, name, obj):
    tmp = f'.{name}.{os.getpid()}.tmp'
    try:
        os.unlink(tmp, dir_fd=dir_fd)
    except FileNotFoundError:
        pass
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644, dir_fd=dir_fd)
    with os.fdopen(fd, 'w') as f:
        json.dump(obj, f)
    os.replace(tmp, name, src_dir_fd=dir_fd, dst_dir_fd=dir_fd)


def remove_entry(dir_fd, name):
    try:
        st = os.lstat(name, dir_fd=dir_fd)
    except FileNotFoundError:
        return
    if stat.S_ISDIR(st.st_mode):
        sub = open_subdir(dir_fd, name)
        try:
            for entry in os.listdir(sub):
                remove_entry(sub, entry)
        finally:
            os.close(sub)
        os.rmdir(name, dir_fd=dir_fd)
    else:
        os.unlink(name, dir_fd=dir_fd)


# --- keys, versions, images ------------------------------------------------------------------------------------

def trusted_keys():
    keys = {}
    for path in sorted(glob.glob(os.path.join(TRUST_DIR, '*.pub'))):
        der = run('openssl', 'pkey', '-pubin', '-in', path, '-outform', 'DER', text=False).stdout
        keys[hashlib.sha256(der).hexdigest()[:16]] = path
    return keys


def image_version(ref):
    r = run('docker', 'image', 'inspect', '-f', '{{json .Config.Env}}', ref, check=False)
    if r.returncode:
        return None
    for e in json.loads(r.stdout):
        if e.startswith('HP_VERSION='):
            return e.split('=', 1)[1]
    return None


def image_id(ref):
    r = run('docker', 'image', 'inspect', '-f', '{{.Id}}', ref, check=False)
    return r.stdout.strip() if r.returncode == 0 else None


def health_version():
    r = run('curl', '-fsS', '-m', '5', HEALTH_URL, check=False, timeout=15)
    if r.returncode:
        return None
    try:
        j = json.loads(r.stdout)
        return j.get('version') if j.get('ok') else None
    except ValueError:
        return None


def wait_healthy(version, timeout=HEALTH_TIMEOUT):
    end = time.time() + timeout
    while time.time() < end:
        if health_version() == version:
            return True
        time.sleep(5)
    return False


def write_host_info(shared):
    write_json(shared, 'host.json', {
        'updaterVersion': UPDATER_VERSION,
        'trustedKeyIds': sorted(trusted_keys().keys()),
        'currentVersion': image_version(f'{IMAGE}:current'),
    })


# --- the update -----------------------------------------------------------------------------------------------

class Progress:
    def __init__(self, shared, version, current):
        self.shared = shared
        self.s = {'state': 'running', 'version': version, 'fromVersion': current, 'steps': [{'name': n, 'status': 'pending'} for n in STEPS],
                  'startedAt': now()}
        self.save()

    def save(self):
        write_json(self.shared, 'status.json', self.s)

    def step(self, i, status='running', message=None):
        for j in range(i):
            if self.s['steps'][j]['status'] in ('pending', 'running'):
                self.s['steps'][j]['status'] = 'done'
        self.s['steps'][i]['status'] = status
        self.s['step'] = STEPS[i]
        if message:
            self.s['message'] = message
        self.save()
        log(f'{STEPS[i]}: {status}{" - " + message if message else ""}')

    def finish(self, state, message):
        if state == 'succeeded':
            for st in self.s['steps']:
                st['status'] = 'done'
        self.s.update(state=state, message=message, finishedAt=now())
        self.save()
        log(f'{state}: {message}')


def verify(shared, version, current, work):
    staged = open_subdir(open_subdir(shared, 'staged'), version)
    manifest_bytes = read_file(staged, 'manifest.json')
    sig = json.loads(read_file(staged, 'manifest.json.sig').decode())
    key_id = str(sig.get('keyId', ''))
    keys = trusted_keys()
    if key_id not in keys:
        raise RuntimeError(f'the release is signed with key {key_id}, which this appliance does not trust')
    with open(os.path.join(work, 'manifest.json'), 'wb') as f:
        f.write(manifest_bytes)
    with open(os.path.join(work, 'manifest.sig'), 'wb') as f:
        f.write(base64.b64decode(sig.get('signature', ''), validate=True))
    r = run('openssl', 'pkeyutl', '-verify', '-rawin', '-pubin', '-inkey', keys[key_id], '-in', os.path.join(work, 'manifest.json'),
            '-sigfile', os.path.join(work, 'manifest.sig'), check=False)
    if r.returncode:
        raise RuntimeError('the release signature is not valid')
    m = json.loads(manifest_bytes.decode())
    img = m.get('image') or {}
    if m.get('product') != 'holodeck-portal' or m.get('version') != version:
        raise RuntimeError('the manifest is for a different product or version')
    if not VERSION_RE.match(str(m.get('minFromVersion', ''))):
        raise RuntimeError('the manifest has no valid minimum version')
    if current and vtuple(version) <= vtuple(current):
        raise RuntimeError(f'{version} is not newer than the running {current}')
    if current and vtuple(current) < vtuple(m['minFromVersion']):
        raise RuntimeError(f'{version} needs at least {m["minFromVersion"]} installed first')
    if not re.match(r'^holodeck-portal-\d+\.\d+\.\d+\.image\.tar\.gz$', str(img.get('file', ''))) or img.get('tag') != f'{IMAGE}:{version}':
        raise RuntimeError('the manifest names an unexpected image')
    if not re.match(r'^[0-9a-f]{64}$', str(img.get('sha256', ''))) or not re.match(r'^sha256:[0-9a-f]{64}$', str(img.get('id', ''))):
        raise RuntimeError('the manifest has no valid image digest')
    # Copy the image to the root-only work folder while hashing it: what was checked is what gets loaded.
    fd = os.open(img['file'], os.O_RDONLY | os.O_NOFOLLOW, dir_fd=staged)
    if not stat.S_ISREG(os.fstat(fd).st_mode):
        raise RuntimeError('the image is not a regular file')
    h = hashlib.sha256()
    size = 0
    dest = os.path.join(work, 'image.tar.gz')
    with os.fdopen(fd, 'rb') as src, open(dest, 'wb') as out:
        while True:
            chunk = src.read(1 << 20)
            if not chunk:
                break
            size += len(chunk)
            if size > int(img.get('size', 0)):
                raise RuntimeError('the image is larger than the manifest says')
            h.update(chunk)
            out.write(chunk)
    if size != int(img['size']) or h.hexdigest() != img['sha256']:
        raise RuntimeError('the image does not match the signed manifest (SHA-256)')
    os.close(staged)
    return m, dest


def only_files(directory, names):
    """copytree filter: keep folders, regular files and links; skip sockets, pipes and devices (SSH connection-sharing
    sockets can't be copied and aren't worth keeping)."""
    skip = []
    for n in names:
        try:
            mode = os.lstat(os.path.join(directory, n)).st_mode
        except FileNotFoundError:
            skip.append(n)
            continue
        if not (stat.S_ISDIR(mode) or stat.S_ISREG(mode) or stat.S_ISLNK(mode)):
            skip.append(n)
    return skip


def backup(version):
    ts = datetime.now().strftime('%Y%m%d-%H%M%S')
    dest = os.path.join(BACKUPS, f'pre-{version}-{ts}')
    os.makedirs(dest, mode=0o700)
    try:
        for name in os.listdir(LIB):
            if (name.startswith('portal.db') or name == 'secret.key') and stat.S_ISREG(os.lstat(os.path.join(LIB, name)).st_mode):
                shutil.copy2(os.path.join(LIB, name), dest, follow_symlinks=False)
        for name in ('ssh', 'trust'):
            if os.path.isdir(os.path.join(LIB, name)) and not os.path.islink(os.path.join(LIB, name)):
                shutil.copytree(os.path.join(LIB, name), os.path.join(dest, name), symlinks=True, ignore=only_files)
        shutil.copytree(ETC, os.path.join(dest, 'etc'), symlinks=True, ignore=only_files)
    except Exception:
        # A half-written backup is worse than none: it could be mistaken for a good one.
        shutil.rmtree(dest, ignore_errors=True)
        raise
    # Keep the newest few.
    olds = sorted(d for d in glob.glob(os.path.join(BACKUPS, 'pre-*')) if os.path.isdir(d))
    for d in olds[:-KEEP_BACKUPS]:
        shutil.rmtree(d, ignore_errors=True)
    return dest


def restore_backup(dest):
    """Puts back everything backup() saved: the database (with its -wal/-shm, stale ones removed first), secret.key,
    the ssh and trust folders, and the settings folder (certificate, gateway token). A rollback must leave the previous
    version with exactly the state it had, whatever the failed version changed."""
    for name in os.listdir(LIB):
        if name.startswith('portal.db'):
            os.unlink(os.path.join(LIB, name))
    for name in os.listdir(dest):
        if name.startswith('portal.db') or name == 'secret.key':
            shutil.copy2(os.path.join(dest, name), os.path.join(LIB, name))
    for name, target in (('ssh', os.path.join(LIB, 'ssh')), ('trust', os.path.join(LIB, 'trust')), ('etc', ETC)):
        src = os.path.join(dest, name)
        if not os.path.isdir(src):
            continue
        # Replace the contents, keeping the folder itself (it is a mount point for the etc volume).
        if os.path.isdir(target) and not os.path.islink(target):
            for entry in os.listdir(target):
                path = os.path.join(target, entry)
                if os.path.isdir(path) and not os.path.islink(path):
                    shutil.rmtree(path)
                else:
                    os.unlink(path)
        else:
            os.makedirs(target, mode=0o700, exist_ok=True)
        shutil.copytree(src, target, symlinks=True, dirs_exist_ok=True)


HOST_FILES = {
    'updater.py': ('/opt/holodeck-appliance/updater.py', 0o755),
    'holodeck-updater.path': ('/etc/systemd/system/holodeck-updater.path', 0o644),
    'holodeck-updater.service': ('/etc/systemd/system/holodeck-updater.service', 0o644),
    'holodeck-portal.service': ('/etc/systemd/system/holodeck-portal.service', 0o644),
}


def refresh_host_files(work):
    """The appliance's own files (this updater, its units, the portal's unit) come with each verified image.
    Trusted keys never do: they only change by hand."""
    cid = run('docker', 'create', f'{IMAGE}:current').stdout.strip()
    try:
        changed = False
        for name, (dest, mode) in HOST_FILES.items():
            tmp = os.path.join(work, f'host-{name}')
            if run('docker', 'cp', f'{cid}:/opt/holodeck-portal/deploy/appliance/{name}', tmp, check=False).returncode:
                continue
            with open(tmp, 'rb') as f:
                new = f.read()
            try:
                with open(dest, 'rb') as f:
                    if f.read() == new:
                        continue
            except FileNotFoundError:
                pass
            shutil.copyfile(tmp, dest + '.new')
            os.chmod(dest + '.new', mode)
            os.replace(dest + '.new', dest)
            if not dest.startswith('/opt/'):
                # Keep the reference copy next to the updater in step with the installed unit.
                shutil.copyfile(dest, os.path.join('/opt/holodeck-appliance', name))
            log(f'updated {dest}')
            changed = True
        if changed:
            run('systemctl', 'daemon-reload', check=False)
    finally:
        run('docker', 'rm', cid, check=False)


def update(shared, version):
    current = image_version(f'{IMAGE}:current')
    p = Progress(shared, version, current)
    work = WORK
    shutil.rmtree(work, ignore_errors=True)
    os.makedirs(work, mode=0o700)
    switched = False
    backup_dir = None
    old_previous = image_id(f'{IMAGE}:previous')
    m = None
    try:
        p.step(0)
        m, image_file = verify(shared, version, current, work)
        p.step(1)
        run('docker', 'load', '-i', image_file)
        if image_id(m['image']['tag']) != m['image']['id']:
            raise RuntimeError('the loaded image is not the one the manifest names')
        p.step(2)
        run('systemctl', 'stop', SERVICE, timeout=180)
        backup_dir = backup(version)
        p.step(3)
        if image_id(f'{IMAGE}:current'):
            run('docker', 'tag', f'{IMAGE}:current', f'{IMAGE}:previous')
        run('docker', 'tag', m['image']['tag'], f'{IMAGE}:current')
        switched = True
        run('systemctl', 'start', SERVICE, timeout=180)
        p.step(4, message=f'Waiting for {version} to answer (up to {HEALTH_TIMEOUT // 60} minutes)')
        if not wait_healthy(version):
            raise RuntimeError(f'{version} did not become healthy within {HEALTH_TIMEOUT // 60} minutes')
        p.step(5)
        remove_entry(open_subdir(shared, 'staged'), version)
        for ref in run('docker', 'images', IMAGE, '--format', '{{.Repository}}:{{.Tag}}').stdout.split():
            if ref not in (f'{IMAGE}:current', f'{IMAGE}:previous') and image_id(ref) not in (image_id(f'{IMAGE}:current'), image_id(f'{IMAGE}:previous')):
                run('docker', 'rmi', ref, check=False)
        run('docker', 'image', 'prune', '-f', check=False)
        refresh_host_files(work)
        p.finish('succeeded', f'Updated from {current} to {version}. Backup: {backup_dir}')
    except Exception as e:  # noqa: BLE001 - every failure must end in a reported state
        failed = next((i for i, s in enumerate(p.s['steps']) if s['status'] == 'running'), 0)
        p.step(failed, 'failed', str(e))
        if switched:
            log('rolling back')
            run('systemctl', 'stop', SERVICE, timeout=180, check=False)
            if backup_dir:
                restore_backup(backup_dir)
            run('docker', 'tag', f'{IMAGE}:previous', f'{IMAGE}:current', check=False)
            # "previous" goes back to what it was, so the older fallback isn't lost.
            if old_previous:
                run('docker', 'tag', old_previous, f'{IMAGE}:previous', check=False)
            run('systemctl', 'start', SERVICE, timeout=180, check=False)
            ok = wait_healthy(current) if current else False
            p.finish('rolled_back', f'{e}. Went back to {current}{"" if ok else " (it is not answering yet: check the appliance)"}; the database, keys and settings were restored from {backup_dir}.')
        else:
            if backup_dir or p.s['steps'][2]['status'] != 'pending':
                run('systemctl', 'start', SERVICE, timeout=180, check=False)
            p.finish('failed', f'{e}. Nothing was changed; {current} keeps running.')
        # A release that failed isn't offered again from this download (a new check can still find it).
        try:
            remove_entry(open_subdir(shared, 'staged'), version)
        except OSError:
            pass
        if m and image_id(m['image']['tag']) not in (image_id(f'{IMAGE}:current'), image_id(f'{IMAGE}:previous')):
            run('docker', 'rmi', m['image']['tag'], check=False)
    finally:
        shutil.rmtree(work, ignore_errors=True)


def main():
    lock = open('/run/holodeck-updater.lock', 'w')
    fcntl.flock(lock, fcntl.LOCK_EX)
    shared = open_shared_dir()
    try:
        raw = None
        try:
            raw = read_file(shared, 'request.json', 4096)
        except FileNotFoundError:
            pass
        finally:
            # Take the request away first, so systemd's path watch doesn't start us again for it.
            try:
                os.unlink('request.json', dir_fd=shared)
            except FileNotFoundError:
                pass
        if raw is not None:
            try:
                version = str(json.loads(raw.decode()).get('version', ''))
            except ValueError:
                version = ''
            if VERSION_RE.match(version):
                update(shared, version)
            else:
                log('ignored a malformed request')
        write_host_info(shared)
    finally:
        os.close(shared)


if __name__ == '__main__':
    try:
        main()
    except Exception as e:  # noqa: BLE001
        log(f'error: {e}')
        sys.exit(1)
