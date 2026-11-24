#!/usr/bin/env python3
"""
Holodeck Portal appliance: applies the OVF properties entered when the OVA was deployed (vSphere hands them to the
VM through VMware Tools as guestinfo.ovfEnv). Runs once, at the first boot; a marker file prevents re-runs.

Properties (all optional except the two passwords): hostname, domain, ip, prefix, gateway, dns, ntp, root_password,
portal_fqdn, admin_password, ssh_enabled.
"""
import os, re, subprocess, sys, xml.etree.ElementTree as ET, datetime, glob, shutil

ETC = '/etc/holodeck-appliance'
DONE = f'{ETC}/.configured'
OE = '{http://schemas.dmtf.org/ovf/environment/1}'


def log(msg):
    print(f'[holodeck-firstboot] {msg}', flush=True)


def run(*cmd, **kw):
    return subprocess.run(cmd, check=True, **kw)


def ovf_properties():
    try:
        xml = subprocess.run(['vmtoolsd', '--cmd', 'info-get guestinfo.ovfEnv'], capture_output=True, text=True, timeout=30).stdout
    except Exception:
        xml = ''
    if not xml.strip():
        return {}
    root = ET.fromstring(xml)
    props = {}
    for p in root.iter(f'{OE}Property'):
        props[p.get(f'{OE}key')] = p.get(f'{OE}value') or ''
    return props


def main():
    if os.path.exists(DONE):
        log('already configured')
        return
    os.makedirs(ETC, exist_ok=True)
    p = ovf_properties()
    if not p:
        log('no OVF environment found (deploy the OVA with vCenter, the ESXi Host Client or ovftool --X:injectOvfEnv so its properties are passed); using DHCP and defaults')

    hostname = (p.get('hostname') or 'holodeck-portal').strip()
    domain = (p.get('domain') or '').strip()
    fqdn = (p.get('portal_fqdn') or (f'{hostname}.{domain}' if domain else hostname)).strip()
    log(f'hostname {hostname}, portal name {fqdn}')
    run('hostnamectl', 'set-hostname', hostname)

    # Network: static when an IP is given, otherwise DHCP. Replaces the build's cloud-init/DHCP files.
    for f in glob.glob('/etc/systemd/network/*.network'):
        os.remove(f)
    ip = (p.get('ip') or '').strip()
    dns = [d.strip() for d in re.split(r'[,\s]+', p.get('dns') or '') if d.strip()]
    lines = ['[Match]', 'Name=e*', '', '[Network]']
    if ip:
        lines += [f"Address={ip}/{(p.get('prefix') or '24').strip()}"]
        if (p.get('gateway') or '').strip():
            lines += [f"Gateway={p['gateway'].strip()}"]
    else:
        lines += ['DHCP=yes']
    lines += [f'DNS={d}' for d in dns]
    if domain:
        lines += [f'Domains={domain}']
    with open('/etc/systemd/network/50-holodeck.network', 'w') as fh:
        fh.write('\n'.join(lines) + '\n')
    os.chmod('/etc/systemd/network/50-holodeck.network', 0o644)
    run('systemctl', 'restart', 'systemd-networkd')
    log(f"network: {'static ' + ip if ip else 'DHCP'}")

    ntp = [n.strip() for n in re.split(r'[,\s]+', p.get('ntp') or '') if n.strip()]
    if ntp:
        with open('/etc/systemd/timesyncd.conf', 'w') as fh:
            fh.write('[Time]\nNTP=' + ' '.join(ntp) + '\n')
        run('systemctl', 'restart', 'systemd-timesyncd')

    # Root: the given password, never expiring; without one root keeps no usable password (console only via reset).
    if p.get('root_password'):
        run('chpasswd', input=f"root:{p['root_password']}\n", text=True)
        today = datetime.date.today().isoformat()
        run('chage', '-d', today, '-M', '99999', 'root')
        log('root password set')

    # Every appliance gets its own identity (unlike images that ship shared SSH keys).
    for f in glob.glob('/etc/ssh/ssh_host_*'):
        os.remove(f)
    run('ssh-keygen', '-A')
    if open('/etc/machine-id').read().strip() == '':
        run('systemd-machine-id-setup')
    # sshd, docker and the portal are ordered after this unit: never wait for them here (that deadlocks the boot).
    # sshd starts by itself once this finishes, with the new keys.
    ssh_on = (p.get('ssh_enabled') or 'True').lower() in ('true', '1', 'yes')
    if ssh_on:
        run('systemctl', 'enable', 'sshd')
    else:
        run('systemctl', 'disable', 'sshd')
        run('systemctl', 'stop', '--no-block', 'sshd')
    log(f"SSH {'enabled' if ssh_on else 'disabled'}")

    with open(f'{ETC}/portal.env', 'w') as fh:
        fh.write(f'HP_HOSTNAME={fqdn}\n')
    if p.get('admin_password'):
        fd = os.open(f'{ETC}/admin-password', os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        os.write(fd, p['admin_password'].encode())
        os.close(fd)
    open(DONE, 'w').close()
    log('done')


if __name__ == '__main__':
    try:
        main()
    except Exception as e:  # never block the boot; the console shows what went wrong
        log(f'failed: {e}')
        sys.exit(1)
