import os
import sys
import hashlib
import paramiko

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')

HOST = "210.246.215.66"
USER = "root"
PASS = "!WFXU#v1aO7338+"
REMOTE_BASE = "/root/FlowUltraTech"
LOCAL_BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

def get_ssh_client():
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, username=USER, password=PASS, timeout=15)
    return client

def run_remote(client, cmd):
    print(f"[$] {cmd}")
    stdin, stdout, stderr = client.exec_command(cmd)
    out = stdout.read().decode('utf-8', errors='replace')
    err = stderr.read().decode('utf-8', errors='replace')
    if out:
        print(out.strip())
    if err:
        print(f"[ERR] {err.strip()}")
    return out, err

def ensure_remote_dir(sftp, remote_dir):
    dirs = remote_dir.replace("\\", "/").split("/")
    current = ""
    for d in dirs:
        if not d:
            current += "/"
            continue
        current += d + "/"
        try:
            sftp.stat(current)
        except IOError:
            try:
                sftp.mkdir(current)
            except Exception:
                pass

def upload_dir(sftp, local_dir, remote_dir, excludes=None):
    if excludes is None:
        excludes = ['__pycache__', '.git', '.venv', 'full_debug']
    ensure_remote_dir(sftp, remote_dir)
    for root, dirs, files in os.walk(local_dir):
        dirs[:] = [d for d in dirs if d not in excludes]
        rel_root = os.path.relpath(root, local_dir).replace("\\", "/")
        target_remote = remote_dir if rel_root == "." else f"{remote_dir}/{rel_root}"
        ensure_remote_dir(sftp, target_remote)
        for f in files:
            if f.endswith('.pyc') or f.endswith('.pyo') or f.endswith('.tmp'):
                continue
            src = os.path.join(root, f)
            dest = f"{target_remote}/{f}"
            local_sz = os.path.getsize(src)
            should_upload = True
            try:
                r_stat = sftp.stat(dest)
                if r_stat.st_size == local_sz:
                    if local_sz < 512 * 1024:
                        with sftp.open(dest, 'rb') as rf, open(src, 'rb') as lf:
                            if rf.read() == lf.read():
                                should_upload = False
                    else:
                        should_upload = False
            except IOError:
                pass
            if should_upload:
                print(f"  [Dist] {src} -> {dest} ({local_sz / (1024*1024):.2f} MB)")
                sftp.put(src, dest)

def main():
    print(f"Connecting to {HOST}...")
    client = get_ssh_client()
    sftp = client.open_sftp()
    print("Connected successfully.")

    # 1. Sync src directory
    print("\n--- Uploading Backend Source Code (src/) ---")
    upload_dir(sftp, os.path.join(LOCAL_BASE, "src"), f"{REMOTE_BASE}/src")

    # 2. Sync python directory (models and solver)
    print("\n--- Uploading Python ML Models & Solver (python/) ---")
    upload_dir(sftp, os.path.join(LOCAL_BASE, "python"), f"{REMOTE_BASE}/python")

    # 3. Sync individual config files
    individual_files = [
        "package.json",
        "tsconfig.json",
        "scripts/reset_and_seed_db.ts",
        "scripts/sync_expired_at.ts",
        "tests/test_realtime_socket.ts",
    ]
    for rel_path in individual_files:
        local_path = os.path.join(LOCAL_BASE, rel_path.replace("/", os.sep))
        if os.path.exists(local_path):
            remote_path = f"{REMOTE_BASE}/{rel_path}"
            ensure_remote_dir(sftp, os.path.dirname(remote_path))
            print(f"Uploading {rel_path} -> {remote_path}")
            sftp.put(local_path, remote_path)

    # 4. Upload built Vite React SPA from backoffice/dist if present
    backoffice_standalone_dist = r"d:\Script\java-script\backoffice\dist"
    local_dist = os.path.join(LOCAL_BASE, "backoffice", "dist")
    if os.path.exists(backoffice_standalone_dist):
        local_dist = backoffice_standalone_dist

    remote_dist = f"{REMOTE_BASE}/backoffice/dist"
    if os.path.exists(local_dist):
        print(f"\n--- Uploading Vite React Backoffice Dist ({local_dist}) ---")
        upload_dir(sftp, local_dist, remote_dist)

    # 5. Upload Public Landing Page (public/)
    local_public = os.path.join(LOCAL_BASE, "public")
    remote_public = f"{REMOTE_BASE}/public"
    if os.path.exists(local_public):
        print(f"\n--- Uploading Public Landing Page ({local_public}) ---")
        upload_dir(sftp, local_public, remote_public)

    # 6. Smart-sync Installer Binaries in storage/releases/
    local_releases_dir = os.path.join(LOCAL_BASE, "storage", "releases")
    remote_releases_dir = f"{REMOTE_BASE}/storage/releases"
    ensure_remote_dir(sftp, remote_releases_dir)
    latest_exe_info = None
    if os.path.exists(local_releases_dir):
        print("\n--- Synchronizing Installers in storage/releases/ ---")
        for f in sorted(os.listdir(local_releases_dir)):
            if not f.endswith(".exe"):
                continue
            src = os.path.join(local_releases_dir, f)
            dest = f"{remote_releases_dir}/{f}"
            local_sz = os.path.getsize(src)
            sha256_hash = hashlib.sha256()
            with open(src, "rb") as lf:
                while chunk := lf.read(1024 * 1024):
                    sha256_hash.update(chunk)
            file_sha256 = sha256_hash.hexdigest().upper()
            if f.startswith("FlowUltraTech_Setup_v"):
                latest_exe_info = (f, local_sz, file_sha256)
            remote_sz = -1
            try:
                r_stat = sftp.stat(dest)
                remote_sz = r_stat.st_size
            except IOError:
                pass
            if local_sz != remote_sz:
                print(f"  Uploading {f} ({local_sz / (1024*1024):.1f} MB)...")
                sftp.put(src, dest)
                print(f"  [SUCCESS] {f} uploaded.")
            else:
                print(f"  [OK] {f} already exists ({local_sz / (1024*1024):.1f} MB)")

    sftp.close()

    # 7. Install packages if needed and rebuild on remote
    print("\n--- Installing Dependencies & Rebuilding TypeScript ---")
    run_remote(client, f"cd {REMOTE_BASE} && npm install && npm run build")

    # 8. Register & Check Active Latest Release in MongoDB
    if latest_exe_info:
        exe_name, exe_size, exe_hash = latest_exe_info
        ver_str = exe_name.replace("FlowUltraTech_Setup_v", "").replace(".exe", "").strip()
        print(f"\n--- Registering Latest Release v{ver_str} in MongoDB ---")
        upsert_release_cmd = (
            'mongosh flowultratech --quiet --eval \''
            'db.app_releases.updateMany({}, { $set: { isLatest: false } }); '
            f'db.app_releases.updateOne({{ version: "{ver_str}" }}, {{ $set: {{ '
            f'version: "{ver_str}", '
            f'minRequiredVersion: "{ver_str}", '
            f'title: "FlowUltraTech v{ver_str} (Native Proxy Bridge & 5-Mode Auto-Reply Studio)", '
            'description: "เพิ่มระบบ Real-time Clock & Live Proof Overlay ซิงก์เวลาจริงผ่าน WebSocket Hot-Reload พร้อมพรีวิวสด WebView2 ในแอป, 6 รูปแบบนาฬิกา, Camera Physics และ One-Click CDP Auto-Inject", '
            f'fileName: "{exe_name}", '
            f'fileSize: {exe_size}, '
            f'fileHash: "{exe_hash}", '
            f'downloadUrl: "/storage/releases/{exe_name}", '
            'isMandatory: true, '
            'isLatest: true, '
            'publishedAt: new Date() '
            '}, $setOnInsert: { downloadsCount: 0 } }, { upsert: true });'
            '\''
        )
        run_remote(client, upsert_release_cmd)

    print("\n--- Checking Active Release in MongoDB ---")
    mongo_release_cmd = (
        'mongosh flowultratech --quiet --eval "'
        'const cur = db.app_releases.findOne({ isLatest: true }); '
        'print(\\"Active Latest Release in DB: \\" + JSON.stringify(cur));'
        '"'
    )
    run_remote(client, mongo_release_cmd)

    # 9. Restart PM2 process
    print("\n--- Restarting PM2 with Landing Page & Installer Routes ---")
    run_remote(client, "pm2 restart flowultratech-backend --update-env")
    run_remote(client, "pm2 status flowultratech-backend")

    # 10. Verify Live HTTP Endpoints
    print("\n--- Verifying Live Endpoints via HTTP ---")
    run_remote(client, "curl -sI http://localhost:8001/ | head -n 6")
    run_remote(client, "curl -sI http://localhost:8001/download | head -n 6")
    run_remote(client, "curl -s http://localhost:8001/api/v1/app/latest-release")
    print("")
    run_remote(client, "curl -s http://localhost:8001/api/v1/app/releases")
    print("")
    run_remote(client, f"curl -sI http://localhost:8001/api/v1/app/download?version={ver_str} | head -n 8")
    run_remote(client, f"curl -sI http://localhost:8001/storage/releases/{exe_name} | head -n 8")

    client.close()
    print("\nDeployment and Live Verification completed successfully!")

if __name__ == "__main__":
    main()
