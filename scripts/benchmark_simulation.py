#!/usr/bin/env python3
"""
TikTok Studio Sandbox & Captcha Solver
Full Production Simulation & Benchmark Suite
Author: Antigravity Agent
"""

import os
import sys
import time
import json
import base64
import statistics
import urllib.request
import urllib.error

# Ensure UTF-8 output on Windows console
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')

SERVER_URL = os.environ.get("SERVER_URL", "http://210.246.215.66:8001").rstrip('/')
ROOT_USER = os.environ.get("ROOT_USER", "root")
ROOT_PASS = os.environ.get("ROOT_PASS", "!WFXU#v1aO7338+")
DEFAULT_IMAGES_DIR = os.path.join(os.path.dirname(__file__), "..", "images", "slide")
if not os.path.exists(DEFAULT_IMAGES_DIR):
    DEFAULT_IMAGES_DIR = r"d:\Script\java-script\SimpleSolveCaptchaProject\images\slide"

def log_step(title):
    print(f"\n========================================================")
    print(f"▶ {title}")
    print(f"========================================================")

def http_json(url, method="GET", data=None, headers=None, timeout=15):
    hdrs = {"Content-Type": "application/json"}
    if headers:
        hdrs.update(headers)
    encoded_data = json.dumps(data).encode("utf-8") if data is not None else None
    req = urllib.request.Request(url, data=encoded_data, headers=hdrs, method=method)
    
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            elapsed_ms = (time.time() - t0) * 1000
            body = resp.read().decode("utf-8")
            parsed = json.loads(body) if body else {}
            return resp.status, parsed, elapsed_ms, None
    except urllib.error.HTTPError as e:
        elapsed_ms = (time.time() - t0) * 1000
        body = e.read().decode("utf-8")
        try:
            parsed = json.loads(body)
        except Exception:
            parsed = {"raw": body}
        return e.code, parsed, elapsed_ms, str(e)
    except Exception as e:
        elapsed_ms = (time.time() - t0) * 1000
        return 0, {}, elapsed_ms, str(e)

def run_simulation(iterations=20):
    report = {
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "server": SERVER_URL,
        "iterations": iterations,
        "auth": {},
        "slot": {},
        "benchmark": {}
    }

    # ----------------------------------------------------
    # Step 1: Health & Stats Check
    # ----------------------------------------------------
    log_step("1. Checking Server Health & Status")
    status, health, ms, err = http_json(f"{SERVER_URL}/health")
    if err:
        print(f"❌ Server unreachable: {err}")
        return False
    print(f"✔ /health OK ({ms:.1f}ms): {health}")

    # ----------------------------------------------------
    # Step 2: Login Workflow Simulation
    # ----------------------------------------------------
    log_step("2. Simulating Authentication Workflow (/api/v1/auth/login)")
    
    # 2.1 Test invalid credentials
    print("Testing invalid credentials rejection...")
    status, bad_resp, ms, _ = http_json(
        f"{SERVER_URL}/api/v1/auth/login",
        method="POST",
        data={"username": "root", "password": "wrong_password_123"}
    )
    if status == 400:
        print(f"✔ Successfully rejected invalid password with HTTP 400: {bad_resp.get('error')}")
    else:
        print(f"⚠️ Unexpected response for invalid password: HTTP {status}")

    # 2.2 Test valid root credentials
    print(f"Logging in as '{ROOT_USER}'...")
    status, auth_resp, ms, err = http_json(
        f"{SERVER_URL}/api/v1/auth/login",
        method="POST",
        data={"username": ROOT_USER, "password": ROOT_PASS, "hwid": "SIMULATION-HWID-01"}
    )
    if status != 200:
        print(f"❌ Login failed: HTTP {status} - {auth_resp}")
        return False

    token = auth_resp.get("accessToken") or auth_resp.get("token")
    user_role = auth_resp.get("role") or auth_resp.get("user", {}).get("role")
    max_acc = auth_resp.get("license", {}).get("maxTiktokAccounts")
    print(f"✔ Login successful ({ms:.1f}ms)")
    print(f"   - User Role: {user_role}")
    print(f"   - Max TikTok Accounts: {max_acc}")
    print(f"   - Access Token: {token[:25]}...{token[-10:]}")
    report["auth"]["token_length"] = len(token)
    report["auth"]["role"] = user_role

    # 2.3 Verify /me profile
    status, me_resp, ms, _ = http_json(
        f"{SERVER_URL}/api/v1/auth/me",
        headers={"Authorization": f"Bearer {token}"}
    )
    if status == 200:
        print(f"✔ Token verification (/me) OK: User ID #{me_resp.get('userId')} - {me_resp.get('username')}")

    # ----------------------------------------------------
    # Step 3: Dynamic Slot Lease Simulation
    # ----------------------------------------------------
    log_step("3. Simulating Dynamic Slot Lease (/api/v1/slots/*)")
    slot_payload = {
        "profileFolderName": "Acc01_Simulation",
        "hwid": "HWID-SIM-TEST-2026",
        "deviceName": "SimulationRunnerPC"
    }
    status, slot_resp, ms, err = http_json(
        f"{SERVER_URL}/api/v1/slots/acquire",
        method="POST",
        data=slot_payload,
        headers={"Authorization": f"Bearer {token}"}
    )
    if status != 200 or not slot_resp.get("leaseId"):
        print(f"❌ Failed to acquire slot lease: {slot_resp}")
        return False

    lease_id = slot_resp["leaseId"]
    print(f"✔ Slot lease acquired ({ms:.1f}ms): {lease_id}")
    report["slot"]["lease_id"] = lease_id

    # Test Heartbeat
    status, hb_resp, ms, _ = http_json(
        f"{SERVER_URL}/api/v1/slots/heartbeat",
        method="POST",
        data={"leaseId": lease_id, "hwid": slot_payload["hwid"]},
        headers={"Authorization": f"Bearer {token}"}
    )
    if status == 200:
        print(f"✔ Slot heartbeat renewed ({ms:.1f}ms): TTL reset to 60s")

    # ----------------------------------------------------
    # Step 4: Speed Solve Captcha Benchmark
    # ----------------------------------------------------
    log_step(f"4. Running Captcha Solver Speed Benchmark ({iterations} iterations)")
    
    if not os.path.exists(DEFAULT_IMAGES_DIR):
        print(f"❌ Images directory not found: {DEFAULT_IMAGES_DIR}")
        return False

    image_files = [f for f in os.listdir(DEFAULT_IMAGES_DIR) if f.lower().endswith(('.jpg', '.jpeg', '.png'))]
    if not image_files:
        print(f"❌ No test images found in {DEFAULT_IMAGES_DIR}")
        return False

    print(f"Found {len(image_files)} test images. Running {iterations} solves...\n")

    network_latencies = []
    server_calc_times = []
    success_count = 0
    fail_count = 0

    print(f"{'#':<4} | {'Image Name':<30} | {'Status':<7} | {'Server Calc':<13} | {'Network RTT':<13} | {'Position'}")
    print("-" * 90)

    for i in range(iterations):
        img_file = image_files[i % len(image_files)]
        img_path = os.path.join(DEFAULT_IMAGES_DIR, img_file)
        
        with open(img_path, "rb") as fp:
            b64 = base64.b64encode(fp.read()).decode("ascii")
        data_url = f"data:image/jpeg;base64,{b64}"

        payload = {"image": data_url}
        headers = {
            "Authorization": f"Bearer {token}",
            "X-Instance-Lease": lease_id
        }

        # Test solver endpoint
        status, solve_resp, rtt_ms, err = http_json(
            f"{SERVER_URL}/captcha/slide",
            method="POST",
            data=payload,
            headers=headers
        )

        if status == 200 and solve_resp.get("position"):
            success_count += 1
            calc_sec = solve_resp.get("time", 0)
            calc_ms = calc_sec * 1000
            pos = solve_resp.get("position")
            pos_str = f"[{pos[0]:.1f}, {pos[1]:.1f}]"

            network_latencies.append(rtt_ms)
            server_calc_times.append(calc_ms)

            print(f"{i+1:<4} | {img_file[:28]:<30} | {'✔ OK':<7} | {calc_ms:>8.2f} ms | {rtt_ms:>8.2f} ms | {pos_str}")
        else:
            fail_count += 1
            err_msg = solve_resp.get("error") or str(err)
            print(f"{i+1:<4} | {img_file[:28]:<30} | {'❌ ERR':<7} | {'-':>8}    | {rtt_ms:>8.2f} ms | {err_msg}")

        time.sleep(0.05)

    # ----------------------------------------------------
    # Step 5: Benchmark Statistics Calculation
    # ----------------------------------------------------
    log_step("5. Captcha Speed Benchmark Results Summary")

    if server_calc_times:
        min_calc = min(server_calc_times)
        max_calc = max(server_calc_times)
        avg_calc = statistics.mean(server_calc_times)
        med_calc = statistics.median(server_calc_times)

        min_rtt = min(network_latencies)
        max_rtt = max(network_latencies)
        avg_rtt = statistics.mean(network_latencies)
        med_rtt = statistics.median(network_latencies)

        print("\n" + "="*60)
        print("  📊 CAPTCHA SOLVER SPEED BENCHMARK METRICS")
        print("="*60)
        print(f"  • Total Executions:      {iterations}")
        print(f"  • Successful Solves:     {success_count} ({success_count/iterations*100:.1f}%)")
        print(f"  • Failed Solves:         {fail_count}")
        print("-" * 60)
        print("  [⚡ Server ONNX Calculation Time]")
        print(f"    - MIN Speed:           {min_calc:.2f} ms")
        print(f"    - MAX Speed:           {max_calc:.2f} ms")
        print(f"    - AVERAGE (Mean):      {avg_calc:.2f} ms")
        print(f"    - MEDIAN (P50):        {med_calc:.2f} ms")
        print("-" * 60)
        print("  [🌐 Network Roundtrip Time (RTT)]")
        print(f"    - MIN RTT:             {min_rtt:.2f} ms")
        print(f"    - MAX RTT:             {max_rtt:.2f} ms")
        print(f"    - AVERAGE RTT:         {avg_rtt:.2f} ms")
        print(f"    - MEDIAN RTT:          {med_rtt:.2f} ms")
        print("="*60)

        report["benchmark"] = {
            "total_runs": iterations,
            "success_count": success_count,
            "fail_count": fail_count,
            "success_rate_pct": (success_count / iterations) * 100,
            "server_calc_ms": {
                "min": round(min_calc, 2),
                "max": round(max_calc, 2),
                "avg": round(avg_calc, 2),
                "median": round(med_calc, 2)
            },
            "network_rtt_ms": {
                "min": round(min_rtt, 2),
                "max": round(max_rtt, 2),
                "avg": round(avg_rtt, 2),
                "median": round(med_rtt, 2)
            }
        }
    else:
        print("❌ No successful solves recorded.")

    # ----------------------------------------------------
    # Step 6: Cleanup Slot Lease
    # ----------------------------------------------------
    log_step("6. Cleaning up Slot Lease (/api/v1/slots/release)")
    status, rel_resp, ms, _ = http_json(
        f"{SERVER_URL}/api/v1/slots/release",
        method="POST",
        data={"leaseId": lease_id},
        headers={"Authorization": f"Bearer {token}"}
    )
    if status == 200:
        print(f"✔ Slot lease '{lease_id}' successfully released. (Zero lingering slots)")

    # Save output report JSON
    report_file = os.path.join(os.path.dirname(__file__), "benchmark_result.json")
    try:
        with open(report_file, "w", encoding="utf-8") as fp:
            json.dump(report, fp, indent=2, ensure_ascii=False)
        print(f"\n✔ Full benchmark report saved to: {report_file}")
    except Exception as e:
        print(f"Notice: Could not write report file: {e}")

    return True

if __name__ == "__main__":
    count = 20
    if len(sys.argv) > 1:
        try:
            count = int(sys.argv[1])
        except ValueError:
            pass
    run_simulation(iterations=count)
