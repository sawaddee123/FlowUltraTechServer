#!/usr/bin/env python3
"""
Comprehensive Automated Test Suite:
1. User CRUD Verification & Root Protection
2. Captcha Image Storage & Superadmin RBAC Inspection
"""

import os
import sys
import time
import json
import base64
import urllib.request
import urllib.error

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')

BASE_URL = os.environ.get("SERVER_URL", "http://210.246.215.66:8001").rstrip('/')
ROOT_USER = os.environ.get("ROOT_USER", "root")
ROOT_PASS = os.environ.get("ROOT_PASS", "!WFXU#v1aO7338+")

TEST_SLIDE_IMG = r"d:\Script\java-script\SimpleSolveCaptchaProject\images\slide\img1747823631632_png.rf.1818e84e5f0f57e5024e3c41fd2795e7.jpg"
TEST_SYMBOL_IMG = r"d:\Script\java-script\SimpleSolveCaptchaProject\images\symbol\a.png"

def log_header(title):
    print("\n" + "=" * 65)
    print(f"  {title}")
    print("=" * 65)

def req(path, method="GET", data=None, token=None, query_token=None):
    url = f"{BASE_URL}{path}"
    if query_token:
        sep = "&" if "?" in url else "?"
        url = f"{url}{sep}token={query_token}"
    
    headers = {}
    if data is not None:
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = f"Bearer {token}"
        
    encoded_data = json.dumps(data).encode("utf-8") if data is not None else None
    request = urllib.request.Request(url, data=encoded_data, headers=headers, method=method)
    
    try:
        with urllib.request.urlopen(request, timeout=20) as resp:
            content_type = resp.headers.get("Content-Type", "")
            raw = resp.read()
            if "application/json" in content_type:
                return resp.status, json.loads(raw.decode("utf-8")), resp.headers
            else:
                return resp.status, raw, resp.headers
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            body = json.loads(raw.decode("utf-8"))
        except Exception:
            body = {"raw": raw.decode("utf-8", errors="replace")}
        return e.code, body, e.headers
    except Exception as e:
        return 0, {"error": str(e)}, {}

def main():
    log_header("1. TESTING ROOT AUTHENTICATION")
    status, body, _ = req("/api/v1/auth/login", method="POST", data={"username": ROOT_USER, "password": ROOT_PASS})
    assert status == 200, f"Login failed: {body}"
    root_token = body.get("token") or body.get("accessToken")
    print(f"[PASS] Root login successful! Token acquired.")

    # Check /api/v1/auth/me
    status, body, _ = req("/api/v1/auth/me", token=root_token)
    print(f"DEBUG /me: status={status}, body={body}")
    assert status == 200, f"/me failed: {body}"
    user_info = body.get("user") or body
    assert user_info.get("username") == ROOT_USER
    print(f"[PASS] /api/v1/auth/me returned: username={user_info.get('username')}, role={user_info.get('role')}, isSystemRoot={user_info.get('isSystemRoot')}")

    # ==========================================================
    # USER CRUD VERIFICATION
    # ==========================================================
    log_header("2. TESTING USER CRUD LIFECYCLE")
    test_uname = f"test_crud_{int(time.time())}"
    test_pwd = "Password123!"

    # 2.1 CREATE USER
    print(f"Creating user '{test_uname}'...")
    create_payload = {
        "username": test_uname,
        "password": test_pwd,
        "role": "user",
        "maxTiktokAccounts": 4,
        "deviceLimit": 2,
        "plan": "pro"
    }
    status, body, _ = req("/api/v1/admin/users", method="POST", data=create_payload, token=root_token)
    assert status == 201, f"Create user failed: status={status}, body={body}"
    created_user = body.get("user", {})
    assert created_user.get("username") == test_uname
    assert created_user.get("license", {}).get("maxTiktokAccounts") == 4
    assert created_user.get("license", {}).get("deviceLimit") == 2
    created_uid = created_user.get("userId")
    print(f"[PASS] User created: userId={created_uid}, username={test_uname}, maxAccounts=4, deviceLimit=2")

    # 2.2 READ USER IN LIST
    print("Reading users list...")
    status, body, _ = req("/api/v1/admin/users", token=root_token)
    assert status == 200
    all_users = body.get("users", [])
    found = next((u for u in all_users if u.get("username") == test_uname), None)
    assert found is not None, f"User {test_uname} not found in users list"
    print(f"[PASS] User found in listing. Total users: {len(all_users)}")

    # 2.3 UPDATE USER
    print(f"Updating user '{test_uname}' quota to 7 and status to 'suspended'...")
    update_payload = {
        "maxTiktokAccounts": 7,
        "deviceLimit": 3,
        "status": "suspended"
    }
    status, body, _ = req(f"/api/v1/admin/users/{test_uname}", method="PUT", data=update_payload, token=root_token)
    assert status == 200, f"Update user failed: status={status}, body={body}"
    updated_user = body.get("user", {})
    assert updated_user.get("license", {}).get("maxTiktokAccounts") == 7
    assert updated_user.get("status") == "suspended"
    print(f"[PASS] User updated successfully: maxAccounts={updated_user.get('license', {}).get('maxTiktokAccounts')}, status={updated_user.get('status')}")

    # 2.4 RESET DEVICES
    print(f"Testing reset-devices for '{test_uname}'...")
    status, body, _ = req(f"/api/v1/admin/users/{test_uname}/reset-devices", method="POST", token=root_token)
    assert status == 200, f"Reset devices failed: {body}"
    print(f"[PASS] Reset devices succeeded: {body}")

    # 2.5 ROOT PROTECTION (CRITICAL)
    print("Testing Root Protection against deletion and suspension...")
    # Attempt to delete root
    status, body, _ = req(f"/api/v1/admin/users/{ROOT_USER}", method="DELETE", token=root_token)
    assert status == 403, f"Root was NOT protected from deletion! status={status}, body={body}"
    print(f"[PASS] Root deletion blocked with HTTP 403 Forbidden! Error: {body.get('error')}")

    # Attempt to suspend root
    status, body, _ = req(f"/api/v1/admin/users/{ROOT_USER}", method="PUT", data={"status": "suspended"}, token=root_token)
    assert status == 403, f"Root was NOT protected from suspension! status={status}, body={body}"
    print(f"[PASS] Root suspension blocked with HTTP 403 Forbidden! Error: {body.get('error')}")

    # 2.6 DELETE TEST USER
    print(f"Deleting user '{test_uname}'...")
    status, body, _ = req(f"/api/v1/admin/users/{test_uname}", method="DELETE", token=root_token)
    assert status == 200, f"Delete user failed: {body}"
    print(f"[PASS] User deleted successfully: {body}")

    # Verify user is gone
    status, body, _ = req("/api/v1/admin/users", token=root_token)
    remaining_users = body.get("users", [])
    assert not any(u.get("username") == test_uname for u in remaining_users)
    print(f"[PASS] Verified user '{test_uname}' no longer exists in system.")

    # ==========================================================
    # CAPTCHA STORAGE & SUPERADMIN INSPECTION VERIFICATION
    # ==========================================================
    log_header("3. TESTING CAPTCHA STORAGE & METADATA LOGGING")
    
    # Check test images
    assert os.path.exists(TEST_SLIDE_IMG), f"Missing test slide image: {TEST_SLIDE_IMG}"
    assert os.path.exists(TEST_SYMBOL_IMG), f"Missing test symbol image: {TEST_SYMBOL_IMG}"

    with open(TEST_SLIDE_IMG, "rb") as f:
        slide_b64 = base64.b64encode(f.read()).decode("utf-8")
    with open(TEST_SYMBOL_IMG, "rb") as f:
        symbol_b64 = base64.b64encode(f.read()).decode("utf-8")

    # Solve Slide Captcha
    print("Sending Slide Captcha solve request...")
    status, body, _ = req("/captcha/slide", method="POST", data={"image": slide_b64}, token=root_token)
    assert status == 200, f"Slide solve failed: {body}"
    print(f"[PASS] Slide Captcha solved: position={body.get('position')}, time={body.get('time')}s")

    # Solve Symbol Captcha
    print("Sending Symbol Captcha solve request...")
    status, body, _ = req("/captcha/symbol", method="POST", data={"image": symbol_b64}, token=root_token)
    assert status == 200, f"Symbol solve failed: {body}"
    print(f"[PASS] Symbol Captcha solved: symbols={body.get('symbol_positions')}, time={body.get('time')}s")

    # Wait 1s for async write to flush
    time.sleep(1)

    # 3.1 SUPERADMIN VIEWING CAPTCHA LOGS
    print("\nFetching Captcha logs via GET /api/v1/admin/captchas as superadmin...")
    status, body, _ = req("/api/v1/admin/captchas?limit=5", token=root_token)
    assert status == 200, f"Get captchas failed: {body}"
    logs = body.get("logs", [])
    assert len(logs) >= 2, f"Expected at least 2 logs, got {len(logs)}"
    print(f"[PASS] Successfully retrieved {len(logs)} captcha logs (Total in DB: {body.get('total')})")

    recent_log = logs[0]
    filename = recent_log.get("imageFilename")
    assert filename, f"Missing imageFilename in log: {recent_log}"
    print(f"[PASS] Verified Log Metadata:")
    print(f"       - Image Filename: {filename}")
    print(f"       - Username: {recent_log.get('username')}")
    print(f"       - Profile Folder: {recent_log.get('profileFolderName')}")
    print(f"       - Captcha Type: {recent_log.get('captchaType')}")
    print(f"       - Result Success: {recent_log.get('result', {}).get('success')}")
    print(f"       - Duration: {recent_log.get('result', {}).get('durationSec')}s")
    print(f"       - Client IP: {recent_log.get('clientIp')}")

    # 3.2 SUPERADMIN FETCHING STORED CAPTCHA IMAGE BINARY
    print(f"\nFetching saved Captcha image binary via GET /api/v1/admin/captchas/{filename}/image?token=...")
    status, img_bytes, headers = req(f"/api/v1/admin/captchas/{filename}/image", query_token=root_token)
    assert status == 200, f"Image fetch failed: status={status}"
    content_type = headers.get("Content-Type", "")
    assert "image/" in content_type, f"Invalid Content-Type: {content_type}"
    assert len(img_bytes) > 500, f"Image file too small ({len(img_bytes)} bytes)"
    print(f"[PASS] Stored image fetched successfully! Size: {len(img_bytes)} bytes, Content-Type: {content_type}")

    # 3.3 RBAC CHECK: NORMAL USER MUST BE BLOCKED (HTTP 403)
    log_header("4. TESTING RBAC ISOLATION (NON-SUPERADMIN BLOCKED)")
    temp_user_name = f"temp_user_{int(time.time())}"
    req("/api/v1/admin/users", method="POST", data={
        "username": temp_user_name,
        "password": "UserPass123!",
        "role": "user",
        "maxTiktokAccounts": 1
    }, token=root_token)

    # Login as normal user
    status, body, _ = req("/api/v1/auth/login", method="POST", data={"username": temp_user_name, "password": "UserPass123!"})
    normal_token = body.get("token") or body.get("accessToken")

    print("Attempting to access /api/v1/admin/captchas as normal user...")
    status, body, _ = req("/api/v1/admin/captchas", token=normal_token)
    assert status == 403, f"Non-superadmin was NOT blocked from captchas list! status={status}, body={body}"
    print(f"[PASS] Normal user blocked with HTTP 403 Forbidden! Message: {body.get('error')}")

    print(f"Attempting to fetch image as normal user...")
    status, body, _ = req(f"/api/v1/admin/captchas/{filename}/image", query_token=normal_token)
    assert status == 403, f"Non-superadmin was NOT blocked from image fetch! status={status}, body={body}"
    print(f"[PASS] Normal user blocked from image with HTTP 403 Forbidden! Message: {body.get('error')}")

    # Clean up temp user
    req(f"/api/v1/admin/users/{temp_user_name}", method="DELETE", token=root_token)
    print(f"[PASS] Temp normal user cleaned up.")

    log_header("ALL 4 TEST PHASES COMPLETED WITH 100% SUCCESS!")

if __name__ == "__main__":
    main()
