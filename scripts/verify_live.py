import sys
import paramiko

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')

HOST = "210.246.215.66"
USER = "root"
PASS = "!WFXU#v1aO7338+"

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, password=PASS, timeout=10)

def run(title, cmd):
    print(f"\n=== {title} ===")
    stdin, stdout, stderr = client.exec_command(cmd)
    out = stdout.read().decode('utf-8', errors='replace')
    err = stderr.read().decode('utf-8', errors='replace')
    if out:
        print(out.strip())
    if err:
        print("[ERR]", err.strip())

# 1. Update MongoDB AppRelease record safely
seed_js = """
const r = {
  version: '1.0.0',
  minRequiredVersion: '1.0.0',
  title: 'TikTok Studio Sandbox v1.0.0',
  description: 'Multi-Instance & Automation Sandbox for TikTok LIVE Studio',
  fileName: 'TikTokStudioSandbox_Setup_v1.0.0.exe',
  fileSize: 54341405,
  fileHash: '7CA29E53FA4FDDB49128FEBF94F745C976B817364F8DC1953D293F8EA0DAD614',
  downloadUrl: '/api/v1/app/download',
  isMandatory: false,
  isLatest: true,
  publishedBy: { userId: 1000000, username: 'root' },
  publishedAt: new Date(),
  downloadsCount: 142
};
db.app_releases.updateMany({}, { $set: { isLatest: false } });
db.app_releases.updateOne({ version: '1.0.0' }, { $set: r }, { upsert: true });
"""
sftp = client.open_sftp()
with sftp.file('/tmp/seed_release.js', 'w') as f:
    f.write(seed_js)
sftp.close()

run("Seeding MongoDB AppRelease", "mongosh tiktok_sandbox /tmp/seed_release.js")

# 2. Check HTTP Root (HTML for browser)
run("GET / (with Accept: text/html)", 'curl -sI -H "Accept: text/html" http://localhost:8001/')

# 3. Check HTTP /download
run("GET /download", "curl -sI http://localhost:8001/download")

# 4. Check HTTP /api/v1/app/latest-release
run("GET /api/v1/app/latest-release", "curl -s http://localhost:8001/api/v1/app/latest-release")

# 5. Check Direct Download Endpoint (/api/v1/app/download)
run("GET /api/v1/app/download (Header check)", "curl -sI http://localhost:8001/api/v1/app/download")

# 6. Check Storage Releases File
run("GET /storage/releases/TikTokStudioSandbox_Setup_v1.0.0.exe (Header check)", "curl -sI http://localhost:8001/storage/releases/TikTokStudioSandbox_Setup_v1.0.0.exe")

# 7. Check Backoffice Route (/backoffice/)
run("GET /backoffice/", "curl -sI http://localhost:8001/backoffice/")

client.close()
