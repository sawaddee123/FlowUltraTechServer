import requests
import json
import time
import sys

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')

BASE_URL = "http://210.246.215.66:8001"
ROOT_USER = "root"
ROOT_PASS = "!WFXU#v1aO7338+"

print("=" * 60)
print("TEST SUITE: Role Separation, Audit Logging & Revert, Cache Manager")
print("=" * 60)

# Helper for login
def login(username, password):
    resp = requests.post(f"{BASE_URL}/api/v1/auth/login", json={
        "username": username,
        "password": password,
        "hwid": f"TEST-HWID-{username}",
        "deviceName": "TestRunner"
    }, timeout=10)
    if resp.status_code != 200:
        raise Exception(f"Login failed for {username}: {resp.status_code} {resp.text}")
    data = resp.json()
    token = data.get("accessToken") or data.get("token")
    return token, data

# 1. Superadmin Login
print("\n[Step 1] Logging in as Superadmin (root)...")
super_token, super_user = login(ROOT_USER, ROOT_PASS)
print(f"Superadmin logged in. ID={super_user.get('userId')}, Role={super_user.get('role')}")
assert super_user.get("role") == "superadmin", "Root user should have superadmin role"

super_headers = {"Authorization": f"Bearer {super_token}"}

# 2. Check Cache Stats endpoint
print("\n[Step 2] Checking Cache Stats (Superadmin)...")
resp = requests.get(f"{BASE_URL}/api/v1/admin/cache-stats", headers=super_headers)
print(f"Cache stats response ({resp.status_code}):", resp.json())
assert resp.status_code == 200

# 3. Create a Normal Admin and a Normal User
test_admin_name = f"test_admin_{int(time.time())}"
test_user_name = f"test_user_{int(time.time())}"

print(f"\n[Step 3] Superadmin creating admin '{test_admin_name}'...")
resp = requests.post(f"{BASE_URL}/api/v1/admin/users", headers=super_headers, json={
    "username": test_admin_name,
    "password": "Password123!",
    "role": "admin",
    "maxTiktokAccounts": 5,
    "deviceLimit": 2,
    "daysValid": 30
})
print(f"Create Admin response ({resp.status_code}):", resp.json().get("message"))
assert resp.status_code == 201

# 4. Login as Normal Admin
print(f"\n[Step 4] Logging in as Normal Admin '{test_admin_name}'...")
admin_token, admin_user = login(test_admin_name, "Password123!")
assert admin_user.get("role") == "admin"
admin_headers = {"Authorization": f"Bearer {admin_token}"}
print(f"Admin logged in successfully.")

# 5. Verify Admin Role Boundaries:
print("\n[Step 5] Testing Admin Role Boundaries:")

# 5a. Admin should NOT be allowed to create a superadmin
resp = requests.post(f"{BASE_URL}/api/v1/admin/users", headers=admin_headers, json={
    "username": f"bad_super_{int(time.time())}",
    "password": "Password123!",
    "role": "superadmin"
})
print(f" - Admin trying to create superadmin: HTTP {resp.status_code} (Expected 403)")
assert resp.status_code == 403, f"Expected 403, got {resp.status_code}"

# 5b. Admin should NOT be allowed to access Audit Logs
resp = requests.get(f"{BASE_URL}/api/v1/admin/logs", headers=admin_headers)
print(f" - Admin trying to access /admin/logs: HTTP {resp.status_code} (Expected 403)")
assert resp.status_code == 403, f"Expected 403, got {resp.status_code}"

# 5c. Admin should NOT be allowed to access Cache Stats
resp = requests.get(f"{BASE_URL}/api/v1/admin/cache-stats", headers=admin_headers)
print(f" - Admin trying to access /admin/cache-stats: HTTP {resp.status_code} (Expected 403)")
assert resp.status_code == 403, f"Expected 403, got {resp.status_code}"

# 5d. Admin CAN create a normal user
print(f" - Admin creating normal user '{test_user_name}'...")
resp = requests.post(f"{BASE_URL}/api/v1/admin/users", headers=admin_headers, json={
    "username": test_user_name,
    "password": "UserPass123!",
    "role": "user",
    "maxTiktokAccounts": 3,
    "deviceLimit": 1,
    "daysValid": 30
})
print(f"   Create normal user response: HTTP {resp.status_code}")
assert resp.status_code == 201

# 6. Verify User Role Boundaries
print(f"\n[Step 6] Logging in as Normal User '{test_user_name}' and testing restrictions...")
user_token, user_profile = login(test_user_name, "UserPass123!")
user_headers = {"Authorization": f"Bearer {user_token}"}

# Normal user cannot access /api/v1/admin/users
resp = requests.get(f"{BASE_URL}/api/v1/admin/users", headers=user_headers)
print(f" - Normal user accessing /admin/users: HTTP {resp.status_code} (Expected 403)")
assert resp.status_code == 403

# 7. Test User Update & Revert Workflow
print(f"\n[Step 7] Testing Audit Logging & Revert for USER_UPDATE...")
# Update user quota from 3 to 10
resp = requests.put(f"{BASE_URL}/api/v1/admin/users/{test_user_name}", headers=super_headers, json={
    "maxTiktokAccounts": 10
})
print(f" - Superadmin updated '{test_user_name}' max accounts to 10: HTTP {resp.status_code}")
assert resp.status_code == 200

# Fetch audit logs to find the USER_UPDATE log
resp = requests.get(f"{BASE_URL}/api/v1/admin/logs?action=USER_UPDATE&limit=5", headers=super_headers)
logs = resp.json().get("logs", [])
print(f" - Retrieved {len(logs)} update logs.")
target_log = None
for l in logs:
    if l.get("targetId") == test_user_name:
        target_log = l
        break

assert target_log is not None, "Target USER_UPDATE log not found"
print(f" - Found target update log: ID={target_log['logId']}, isReversible={target_log['isReversible']}")
print(f"   Changes before: maxTiktokAccounts={target_log['changes']['before']['license']['maxTiktokAccounts']}")
print(f"   Changes after:  maxTiktokAccounts={target_log['changes']['after']['license']['maxTiktokAccounts']}")

# Trigger Revert
print(f" - Triggering REVERT on log {target_log['logId']}...")
resp = requests.post(f"{BASE_URL}/api/v1/admin/logs/{target_log['logId']}/revert", headers=super_headers)
print(f"   Revert response (HTTP {resp.status_code}):", resp.json())
assert resp.status_code == 200

# Verify user data is restored back to 3 accounts
resp = requests.get(f"{BASE_URL}/api/v1/admin/users", headers=super_headers)
user_list = resp.json().get("users", [])
restored_user = next((u for u in user_list if u["username"] == test_user_name), None)
assert restored_user is not None
print(f"   Verified restored user maxTiktokAccounts: {restored_user['license']['maxTiktokAccounts']} (Expected 3)")
assert restored_user['license']['maxTiktokAccounts'] == 3, f"Expected 3, got {restored_user['license']['maxTiktokAccounts']}"

# 8. Test User Delete & Revert Workflow
print(f"\n[Step 8] Testing Audit Logging & Revert for USER_DELETE...")
resp = requests.delete(f"{BASE_URL}/api/v1/admin/users/{test_user_name}", headers=super_headers)
print(f" - Deleted user '{test_user_name}': HTTP {resp.status_code}")
assert resp.status_code == 200

# Verify user is gone
resp = requests.get(f"{BASE_URL}/api/v1/admin/users", headers=super_headers)
user_list = resp.json().get("users", [])
deleted_user = next((u for u in user_list if u["username"] == test_user_name), None)
assert deleted_user is None, "User should be deleted"
print(f"   Verified user '{test_user_name}' is deleted from DB.")

# Fetch delete audit log
resp = requests.get(f"{BASE_URL}/api/v1/admin/logs?action=USER_DELETE&limit=5", headers=super_headers)
del_logs = resp.json().get("logs", [])
del_log = next((l for l in del_logs if l.get("targetId") == test_user_name), None)
assert del_log is not None, "Delete log not found"
print(f" - Found delete log: ID={del_log['logId']}, isReversible={del_log['isReversible']}")

# Trigger Revert for Deleted User
print(f" - Triggering REVERT to resurrect user '{test_user_name}'...")
resp = requests.post(f"{BASE_URL}/api/v1/admin/logs/{del_log['logId']}/revert", headers=super_headers)
print(f"   Revert response (HTTP {resp.status_code}):", resp.json())
assert resp.status_code == 200

# Verify user is resurrected and can log in again!
print(f" - Verifying resurrected user can log in with original password...")
resurrected_token, resurrected_profile = login(test_user_name, "UserPass123!")
assert resurrected_profile["username"] == test_user_name
print(f"   RESURRECTION CONFIRMED! User logged in successfully. maxAccounts={resurrected_profile['license']['maxTiktokAccounts']}")

# 9. Clean up test users
print(f"\n[Step 9] Cleaning up test users...")
requests.delete(f"{BASE_URL}/api/v1/admin/users/{test_user_name}", headers=super_headers)
requests.delete(f"{BASE_URL}/api/v1/admin/users/{test_admin_name}", headers=super_headers)
print("   Cleaned up test users.")

# 10. Cache Manager Performance & Query Saving Check
print("\n[Step 10] Checking Cache Manager Metrics...")
for _ in range(10):
    requests.get(f"{BASE_URL}/api/v1/admin/stats", headers=super_headers)

resp = requests.get(f"{BASE_URL}/api/v1/admin/cache-stats", headers=super_headers)
cache_metrics = resp.json().get("metrics", {})
print("   Cache Metrics:", json.dumps(cache_metrics, indent=2))
assert cache_metrics.get("hits", 0) > 0, "Cache should have recorded hits"
assert cache_metrics.get("queriesSaved", 0) > 0, "Cache should have saved DB queries"
print(f"   Hit Rate: {cache_metrics.get('hitRatePercent')}% | Queries Saved: {cache_metrics.get('queriesSaved')}")

print("\n" + "=" * 60)
print("ALL TESTS PASSED SUCCESSFULLY! 100% VERIFIED!")
print("=" * 60)
