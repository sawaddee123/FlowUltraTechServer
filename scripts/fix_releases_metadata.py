import os
import hashlib
import paramiko

HOST = "210.246.215.66"
USER = "root"
PASS = "!WFXU#v1aO7338+"
REMOTE_BASE = "/root/SimpleSolveCaptchaProject"
LOCAL_RELEASES = r"d:\Script\java-script\SimpleSolveCaptchaProject\storage\releases"

def calculate_sha256(filepath):
    sha = hashlib.sha256()
    with open(filepath, "rb") as f:
        while chunk := f.read(1024 * 1024):
            sha.update(chunk)
    return sha.hexdigest().lower()

def main():
    print(f"Connecting to {HOST}...")
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, username=USER, password=PASS, timeout=15)

    files = [f for f in os.listdir(LOCAL_RELEASES) if f.endswith(".exe")]
    print(f"Found {len(files)} release files locally.")

    for f in sorted(files):
        local_path = os.path.join(LOCAL_RELEASES, f)
        size = os.path.getsize(local_path)
        sha = calculate_sha256(local_path)
        print(f"File: {f} | Size: {size} bytes | SHA256: {sha}")

        # Extract version from filename e.g. TikTokStudioSandbox_Setup_v0.1.3.exe
        # or match by fileName in DB
        mongo_cmd = f"""mongosh tiktok_sandbox --quiet --eval '
            const res = db.app_releases.updateOne(
                {{ fileName: "{f}" }},
                {{ $set: {{ fileSize: {size}, fileHash: "{sha}" }} }}
            );
            print("{f}: matched=" + res.matchedCount + ", modified=" + res.modifiedCount);
        '"""
        stdin, stdout, stderr = client.exec_command(mongo_cmd)
        out = stdout.read().decode('utf-8', errors='replace').strip()
        err = stderr.read().decode('utf-8', errors='replace').strip()
        print("  " + out)
        if err:
            print("  [ERR] " + err)

    # Also print all releases in DB now
    check_cmd = """mongosh tiktok_sandbox --quiet --eval '
        db.app_releases.find({}, { version: 1, fileName: 1, fileSize: 1, fileHash: 1, isLatest: 1 }).toArray();
    '"""
    stdin, stdout, stderr = client.exec_command(check_cmd)
    print("\n--- Current App Releases in DB ---")
    print(stdout.read().decode('utf-8', errors='replace').strip())

    client.close()

if __name__ == "__main__":
    main()
