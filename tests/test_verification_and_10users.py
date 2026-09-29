import requests
import json
import base64
import time
import sys

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')

BASE_URL = "http://210.246.215.66:8001"
ROOT_USER = "root"
ROOT_PASS = "!WFXU#v1aO7338+"

print("=" * 60)
print("TEST SUITE: 10 Users Login & Captcha Real Lifecycle Verification")
print("=" * 60)

# 1. Verify Root Superadmin Login
print("\n[Step 1] Verifying Superadmin (root) login...")
resp = requests.post(f"{BASE_URL}/api/v1/auth/login", json={
    "username": ROOT_USER,
    "password": ROOT_PASS,
    "hwid": "VERIFIER-SUPERADMIN-HWID",
    "deviceName": "TestRunner"
})
assert resp.status_code == 200, f"Root login failed: {resp.text}"
root_data = resp.json()
root_token = root_data["accessToken"]
print(f" ✓ Root logged in. Role={root_data['role']}, ID={root_data['userId']}")
assert root_data["role"] == "superadmin"

# 2. Verify all 10 Test Users (test1 - test10)
print("\n[Step 2] Verifying login for 10 Test Users (test1 to test10)...")
user_tokens = {}
for i in range(1, 11):
    uname = f"test{i}"
    upass = f"test{i}"
    resp = requests.post(f"{BASE_URL}/api/v1/auth/login", json={
        "username": uname,
        "password": upass,
        "hwid": f"TEST-DEVICE-HWID-{i}",
        "deviceName": f"Device_{i}"
    })
    assert resp.status_code == 200, f"Login failed for {uname}: {resp.status_code} {resp.text}"
    udata = resp.json()
    user_tokens[uname] = udata["accessToken"]
    assert udata["role"] == "user"
    assert udata["maxTiktokAccounts"] == 5
    assert udata["deviceLimit"] == 2
    print(f" ✓ User [{i}/10] '{uname}' logged in successfully. MaxAccounts={udata['maxTiktokAccounts']}, Devices={udata['deviceLimit']}")

# 3. Verify Users list in Admin API
print("\n[Step 3] Verifying User list from Admin API...")
headers_root = {"Authorization": f"Bearer {root_token}"}
resp = requests.get(f"{BASE_URL}/api/v1/admin/users", headers=headers_root)
assert resp.status_code == 200
users_in_db = resp.json().get("users", [])
print(f" ✓ Found {len(users_in_db)} users in database (root + 10 test users).")
assert len(users_in_db) == 11, f"Expected 11 users, got {len(users_in_db)}"

# 4. Acquire Active Lease for test1
print("\n[Step 4] Acquiring slot lease for 'test1'...")
test1_token = user_tokens["test1"]
headers_test1 = {"Authorization": f"Bearer {test1_token}"}
resp = requests.post(f"{BASE_URL}/api/v1/slots/acquire", headers=headers_test1, json={
    "profileFolderName": "Acc01_Live",
    "hwid": "TEST-DEVICE-HWID-1"
})
assert resp.status_code == 200, f"Slot acquire failed: {resp.text}"
lease_id = resp.json().get("leaseId")
print(f" ✓ Slot acquired. LeaseId={lease_id}")

# 5. Send Captcha Solve Request (Lifecycle phase 1: CALCULATED)
print("\n[Step 5] Sending Captcha Solve Request with X-Instance-Lease...")
# Load a real sample slide captcha image
sample_img_path = r"d:\Script\java-script\SimpleSolveCaptchaProject\images\slide\img1747823631632_png.rf.1818e84e5f0f57e5024e3c41fd2795e7.jpg"
with open(sample_img_path, "rb") as f:
    b64_image = base64.b64encode(f.read()).decode("utf-8")

captcha_headers = {
    "Authorization": f"Bearer {test1_token}",
    "X-Instance-Lease": lease_id,
    "Content-Type": "application/json"
}

resp = requests.post(f"{BASE_URL}/api/v1/captcha/slide", headers=captcha_headers, json={
    "image": b64_image
})
print(f" - Solve response status: HTTP {resp.status_code}")
solve_data = resp.json()
print("   Solve Response:", solve_data)
captcha_id = solve_data.get("captchaId")
assert captcha_id is not None, "Solver must return a captchaId"
initial_status = solve_data.get("status")
print(f" ✓ Captcha received ID: {captcha_id}, Initial Status: {initial_status}")

# 6. Verify Captcha Log in Admin API shows initial status
print("\n[Step 6] Verifying Captcha Log recorded initially...")
resp = requests.get(f"{BASE_URL}/api/v1/admin/captcha-logs", headers=headers_root)
logs = resp.json().get("logs", [])
target_log = next((l for l in logs if l.get("captchaId") == captcha_id), None)
assert target_log is not None, "Captcha log not found in database"
print(f" ✓ Initial DB record: status='{target_log['status']}', success={target_log['result']['success']}")
assert target_log["result"]["success"] == False, "Result success must be false before TikTok verification"

# 7. Send Real TikTok Verification Feedback: VERIFIED_SUCCESS
print("\n[Step 7] Client sending REAL verification feedback: VERIFIED_SUCCESS...")
feedback_resp = requests.post(f"{BASE_URL}/api/v1/captcha/feedback", json={
    "captchaId": captcha_id,
    "status": "VERIFIED_SUCCESS",
    "feedbackText": "Success: Modal dismissed and toast verified",
    "elapsedSeconds": 1.85,
    "attempts": 1
})
print(f" - Feedback response status: HTTP {feedback_resp.status_code}")
assert feedback_resp.status_code == 200
print("   Feedback response:", feedback_resp.json())

# 8. Verify Captcha Log in DB is now VERIFIED_SUCCESS
print("\n[Step 8] Verifying Captcha Log updated to VERIFIED_SUCCESS in DB...")
resp = requests.get(f"{BASE_URL}/api/v1/admin/captcha-logs", headers=headers_root)
logs = resp.json().get("logs", [])
updated_log = next((l for l in logs if l.get("captchaId") == captcha_id), None)
assert updated_log is not None
print(f" ✓ Updated DB record: status='{updated_log['status']}', success={updated_log['result']['success']}")
assert updated_log["status"] == "VERIFIED_SUCCESS"
assert updated_log["result"]["success"] == True
assert updated_log["verification"]["feedbackText"] == "Success: Modal dismissed and toast verified"

# 9. Test VERIFIED_FAILED workflow
print("\n[Step 9] Testing VERIFIED_FAILED workflow (when TikTok rejects the solve)...")
resp2 = requests.post(f"{BASE_URL}/api/v1/captcha/slide", headers=captcha_headers, json={
    "image": b64_image
})
solve_data2 = resp2.json()
captcha_id2 = solve_data2.get("captchaId")
print(f" - Second Captcha ID: {captcha_id2}")

# Send failed feedback from client
feedback_resp2 = requests.post(f"{BASE_URL}/api/v1/captcha/feedback", json={
    "captchaId": captcha_id2,
    "status": "VERIFIED_FAILED",
    "feedbackText": "Verification failed: slider mismatch on TikTok UI",
    "elapsedSeconds": 2.10
})
assert feedback_resp2.status_code == 200

# Verify second log in DB is VERIFIED_FAILED
resp = requests.get(f"{BASE_URL}/api/v1/admin/captcha-logs", headers=headers_root)
logs = resp.json().get("logs", [])
failed_log = next((l for l in logs if l.get("captchaId") == captcha_id2), None)
assert failed_log is not None
print(f" ✓ Failed solve DB record: status='{failed_log['status']}', success={failed_log['result']['success']}")
assert failed_log["status"] == "VERIFIED_FAILED"
assert failed_log["result"]["success"] == False

# 10. Clean up active lease
print("\n[Step 10] Cleaning up slot lease...")
requests.post(f"{BASE_URL}/api/v1/slots/release", headers=headers_test1, json={
    "leaseId": lease_id
})
print(" ✓ Released slot lease.")

print("\n" + "=" * 60)
print("ALL VERIFICATION TESTS PASSED 100%!")
print("=" * 60)
