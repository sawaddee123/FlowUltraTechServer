import requests
import json
import time
import sys
from datetime import datetime, timezone, timedelta

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')

BASE_URL = "http://210.246.215.66:8001"
ROOT_USER = "root"
ROOT_PASS = "!WFXU#v1aO7338+"

def log(msg):
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}")

def main():
    log("==================================================================")
    log("VERIFICATION: SUPERADMIN LOCKOUT, EXPIRATION (+2H), & REAL QUOTA")
    log("==================================================================")

    # 1. Login as root
    log("\n[Step 1] Logging in as root superadmin...")
    resp = requests.post(f"{BASE_URL}/api/v1/auth/login", json={
        "username": ROOT_USER,
        "password": ROOT_PASS,
        "hwid": "VERIFY-SCRIPT-HWID"
    })
    assert resp.status_code == 200, f"Root login failed: {resp.text}"
    root_data = resp.json()
    root_token = root_data["accessToken"]
    headers = {"Authorization": f"Bearer {root_token}", "Content-Type": "application/json"}
    log("✓ Root login successful.")

    # 2. Test Superadmin Lockout
    log("\n[Step 2] Testing Superadmin Lockout...")
    
    # 2a. Try to create user with role 'superadmin'
    create_resp = requests.post(f"{BASE_URL}/api/v1/admin/users", headers=headers, json={
        "username": "fake_superadmin_test",
        "password": "password123",
        "role": "superadmin"
    })
    log(f"  Attempt create user with role='superadmin': Status {create_resp.status_code} ({create_resp.json().get('error')})")
    assert create_resp.status_code == 403, f"Expected 403, got {create_resp.status_code}"
    log("  ✓ Blocked creation of additional superadmin (403 Forbidden).")

    # 2b. Try to promote existing user 'test1' to 'superadmin'
    update_resp = requests.put(f"{BASE_URL}/api/v1/admin/users/test1", headers=headers, json={
        "role": "superadmin"
    })
    log(f"  Attempt promote 'test1' to role='superadmin': Status {update_resp.status_code} ({update_resp.json().get('error')})")
    assert update_resp.status_code == 403, f"Expected 403, got {update_resp.status_code}"
    log("  ✓ Blocked promoting user to superadmin (403 Forbidden).")

    # 2c. Try to demote 'root'
    demote_root_resp = requests.put(f"{BASE_URL}/api/v1/admin/users/root", headers=headers, json={
        "role": "admin"
    })
    log(f"  Attempt change root role to 'admin': Status {demote_root_resp.status_code} ({demote_root_resp.json().get('error')})")
    assert demote_root_resp.status_code == 403, f"Expected 403, got {demote_root_resp.status_code}"
    log("  ✓ Blocked changing root's role (403 Forbidden).")

    # 3. Test Expiration Date & +2 Hours Emergency Grace Period
    log("\n[Step 3] Testing Expiration Date & +2 Hours Grace Period...")
    
    # Check users list has top-level expiredAt
    users_resp = requests.get(f"{BASE_URL}/api/v1/admin/users", headers=headers)
    assert users_resp.status_code == 200
    users = users_resp.json().get("users", [])
    test1_user = next((u for u in users if u["username"] == "test1"), None)
    assert test1_user is not None
    assert "expiredAt" in test1_user, "Missing top-level expiredAt in User object"
    log(f"  ✓ User 'test1' has top-level expiredAt: {test1_user['expiredAt']}")

    # 3a. Set test1 to expired (10 minutes ago)
    past_iso = (datetime.now(timezone.utc) - timedelta(minutes=10)).isoformat()
    expire_resp = requests.put(f"{BASE_URL}/api/v1/admin/users/test1", headers=headers, json={
        "expiredAt": past_iso
    })
    assert expire_resp.status_code == 200
    log("  ✓ Set 'test1' expiry date to past (expired).")

    # 3b. Attempt login as expired test1 -> Must return 403 LICENSE_EXPIRED
    login_expired_resp = requests.post(f"{BASE_URL}/api/v1/auth/login", json={
        "username": "test1",
        "password": "test1",
        "hwid": "TEST1-HWID"
    })
    log(f"  Attempt login as expired user 'test1': Status {login_expired_resp.status_code} ({login_expired_resp.json().get('error')})")
    assert login_expired_resp.status_code == 403, f"Expected 403, got {login_expired_resp.status_code}"
    assert login_expired_resp.json().get("error") == "LICENSE_EXPIRED"
    log("  ✓ Blocked expired login with LICENSE_EXPIRED (403).")

    # 3c. Grant +2 Hours Emergency Grace Period via POST /users/test1/grace-period
    grace_resp = requests.post(f"{BASE_URL}/api/v1/admin/users/test1/grace-period", headers=headers, json={
        "hours": 2
    })
    assert grace_resp.status_code == 200, f"Grace period failed: {grace_resp.text}"
    grace_data = grace_resp.json()
    new_expiry = grace_data["expiredAt"]
    log(f"  ✓ Granted +2 Hours Grace Period: new expiry = {new_expiry}, status = {grace_data['user']['status']}")

    # 3d. Now login as test1 should SUCCEED immediately!
    login_renewed_resp = requests.post(f"{BASE_URL}/api/v1/auth/login", json={
        "username": "test1",
        "password": "test1",
        "hwid": "TEST1-HWID"
    })
    assert login_renewed_resp.status_code == 200, f"Login after grace period failed: {login_renewed_resp.text}"
    test1_token = login_renewed_resp.json()["accessToken"]
    log("  ✓ Login as 'test1' succeeded immediately after 2-hour grace period!")

    # 4. Test Quota Reduction & Real Instance Termination
    log("\n[Step 4] Testing Real Quota Reduction Enforcement...")
    
    # 4a. Reset test1 max accounts to 3
    requests.put(f"{BASE_URL}/api/v1/admin/users/test1", headers=headers, json={
        "maxTiktokAccounts": 3
    })

    # Acquire 3 slot leases for test1
    t1_headers = {"Authorization": f"Bearer {test1_token}", "Content-Type": "application/json"}
    leases = []
    for i in range(1, 4):
        acq_resp = requests.post(f"{BASE_URL}/api/v1/slots/acquire", headers=t1_headers, json={
            "profileFolderName": f"Account_0{i}",
            "hwid": "TEST1-HWID"
        })
        assert acq_resp.status_code == 200, f"Failed acquire slot {i}: {acq_resp.text}"
        lease_id = acq_resp.json()["leaseId"]
        leases.append(lease_id)
        log(f"  Acquired slot #{i}: {lease_id} for Account_0{i}")

    # Verify 3 leases active
    leases_resp = requests.get(f"{BASE_URL}/api/v1/admin/leases", headers=headers)
    all_leases = leases_resp.json().get("leases") or leases_resp.json().get("activeLeases") or []
    t1_active = [l for l in all_leases if l["userId"] == 1000001]
    assert len(t1_active) == 3, f"Expected 3 active leases, got {len(t1_active)}"
    log("  ✓ 3 slots actively leased for test1.")

    # 4b. Admin reduces quota from 3 to 2 accounts!
    log("  Admin reduces quota for test1 from 3 accounts -> 2 accounts...")
    reduce_resp = requests.put(f"{BASE_URL}/api/v1/admin/users/test1", headers=headers, json={
        "maxTiktokAccounts": 2
    })
    assert reduce_resp.status_code == 200
    log("  ✓ Quota updated on server.")

    # Check active leases in DB - excess lease MUST be revoked!
    leases_resp_after = requests.get(f"{BASE_URL}/api/v1/admin/leases", headers=headers)
    all_leases_after = leases_resp_after.json().get("leases") or leases_resp_after.json().get("activeLeases") or []
    t1_active_after = [l for l in all_leases_after if l["userId"] == 1000001]
    log(f"  Active leases count in DB after reduction: {len(t1_active_after)} (quota is 2)")
    assert len(t1_active_after) == 2, f"Expected 2 active leases after reduction, got {len(t1_active_after)}"
    log("  ✓ Server immediately revoked the excess lease from DB!")

    # 4c. Heartbeat on the revoked lease MUST return 403/404 with SLOT_REVOKED
    revoked_lease_id = [l for l in leases if l not in [al["leaseId"] for al in t1_active_after]][0]
    log(f"  Sending heartbeat from client for revoked lease: {revoked_lease_id}...")
    hb_resp = requests.post(f"{BASE_URL}/api/v1/slots/heartbeat", headers=t1_headers, json={
        "leaseId": revoked_lease_id,
        "hwid": "TEST1-HWID"
    })
    log(f"  Heartbeat response: Status {hb_resp.status_code} ({hb_resp.json()})")
    assert hb_resp.status_code in [403, 404]
    assert hb_resp.json().get("error") == "SLOT_REVOKED"
    log("  ✓ Heartbeat returned 404/403 SLOT_REVOKED! Triggers immediate client screen kill!")

    # 5. Clean up: restore test1 to 1 year expiry and 5 accounts
    requests.put(f"{BASE_URL}/api/v1/admin/users/test1", headers=headers, json={
        "maxTiktokAccounts": 5,
        "extendDays": 365
    })
    # Release remaining leases
    for l in t1_active_after:
        requests.delete(f"{BASE_URL}/api/v1/admin/leases/{l['leaseId']}", headers=headers)

    log("\n==================================================================")
    log("ALL VERIFICATION CHECKS PASSED 100% SUCCESSFULLY!")
    log("==================================================================")

if __name__ == "__main__":
    main()
