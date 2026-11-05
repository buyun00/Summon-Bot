"""Prepare a private Developer ID CSR, or import Apple's issued certificate into GitHub."""
import base64
import datetime
import os
import pathlib
import secrets
import subprocess
import sys

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.serialization import pkcs12
from cryptography.x509.oid import NameOID, ObjectIdentifier

root = pathlib.Path.home() / '.codex/private/summon-macos-signing'
root.mkdir(parents=True, exist_ok=True)
key_path = root / 'developer-id.key'
csr_path = root / 'Summon-Developer-ID.certSigningRequest'

def main():
    if sys.argv[1:] == ['prepare']:
        if key_path.exists():
            key = serialization.load_pem_private_key(key_path.read_bytes(), password=None)
        else:
            key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
            with key_path.open('xb') as file:
                file.write(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
        csr = x509.CertificateSigningRequestBuilder().subject_name(x509.Name([
            x509.NameAttribute(NameOID.COMMON_NAME, 'Summon Bot Developer ID'),
            x509.NameAttribute(NameOID.ORGANIZATIONAL_UNIT_NAME, '6Y29E7PSVF')])).sign(key, hashes.SHA256())
        csr_path.write_bytes(csr.public_bytes(serialization.Encoding.PEM))
        print('CSR ready: ' + str(csr_path))
        return
    if len(sys.argv) != 3 or sys.argv[1] != 'configure':
        raise ValueError('Use prepare, or configure PATH_TO_APPLE_CER')
    raw = pathlib.Path(sys.argv[2]).read_bytes()
    cert = x509.load_pem_x509_certificate(raw) if raw.startswith(b'-----BEGIN') else x509.load_der_x509_certificate(raw)
    key = serialization.load_pem_private_key(key_path.read_bytes(), password=None)
    now = datetime.datetime.now(datetime.timezone.utc)
    if cert.public_key().public_numbers() != key.public_key().public_numbers():
        raise ValueError('Certificate does not match the prepared private key')
    if not cert.not_valid_before_utc <= now < cert.not_valid_after_utc:
        raise ValueError('Certificate is not currently valid')
    if '6Y29E7PSVF' not in [v.value for v in cert.subject.get_attributes_for_oid(NameOID.ORGANIZATIONAL_UNIT_NAME)]:
        raise ValueError('Certificate belongs to a different Apple team')
    if not any(v.value.startswith('Developer ID Application:') for v in cert.subject.get_attributes_for_oid(NameOID.COMMON_NAME)):
        raise ValueError('Developer ID Application is required; iOS or Installer certificates cannot be used')
    cert.extensions.get_extension_for_oid(ObjectIdentifier('1.2.840.113635.100.6.1.13'))
    password = secrets.token_urlsafe(32)
    # macOS security import requires the compatible PKCS#12 format. GitHub Secrets protects storage.
    encryption = (serialization.PrivateFormat.PKCS12.encryption_builder().kdf_rounds(50000)
        .key_cert_algorithm(pkcs12.PBES.PBESv1SHA1And3KeyTripleDESCBC)
        .hmac_hash(hashes.SHA1()).build(password.encode()))
    p12 = pkcs12.serialize_key_and_certificates(b'Summon Developer ID', key, cert, None,
        encryption)
    # Reuse the already authorized GitHub login, with no token in command arguments.
    auth = subprocess.run(['gh', 'auth', 'token'], capture_output=True, text=True)
    if auth.returncode: raise RuntimeError('GitHub CLI login required')
    env = {**os.environ, 'GH_TOKEN': auth.stdout.strip()}
    for name, value in [('SUMMON_MACOS_P12_BASE64', base64.b64encode(p12).decode()), ('SUMMON_MACOS_P12_PASSWORD', password)]:
        result = subprocess.run(['gh', 'secret', 'set', name, '--repo', 'buyun00/Summon-Bot'], input=value,
                                text=True, capture_output=True, env=env)
        if result.returncode: raise RuntimeError('Unable to configure GitHub secret ' + name)
    (root / 'developer-id.cer').write_bytes(cert.public_bytes(serialization.Encoding.DER))
    print('Developer ID certificate and private key configured for Summon-Bot GitHub Actions.')

if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('macOS signing configuration failed (' + type(error).__name__ + '); check certificate type, team, private key and GitHub login.', file=sys.stderr)
        sys.exit(1)
