import { io, Socket } from "socket.io-client";

const BASE_URL = process.env.TEST_SERVER_URL || "http://127.0.0.1:8001";

interface BenchmarkResult {
  name: string;
  latencyMs: number;
  passed: boolean;
  details?: any;
}

const results: BenchmarkResult[] = [];

async function loginUser(username: string, password: string): Promise<string> {
  const resp = await fetch(`${BASE_URL}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password, hwid: "TEST_REALTIME_BENCHMARK_HWID" }),
  });

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Login failed for ${username}: ${resp.status} - ${txt}`);
  }

  const data = await resp.json() as { accessToken: string };
  return data.accessToken;
}

function connectSocket(token: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = io(BASE_URL, {
      auth: { token },
      transports: ["websocket"],
      timeout: 5000,
      reconnection: false,
    });

    const timer = setTimeout(() => {
      socket.disconnect();
      reject(new Error("Socket connection timeout"));
    }, 5000);

    socket.on("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });

    socket.on("connect_error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function waitForEvent<T = any>(socket: Socket, event: string, timeoutMs = 3000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`Timeout waiting for event '${event}' after ${timeoutMs}ms`));
    }, timeoutMs);

    const handler = (data: T) => {
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(data);
    };

    socket.on(event, handler);
  });
}

async function runRealtimeBenchmarks() {
  console.log("================================================================================");
  console.log("⚡ REAL-TIME BIDIRECTIONAL SOCKET.IO LATENCY & EVENT PROPAGATION BENCHMARK");
  console.log(`🎯 Server Endpoint: ${BASE_URL}`);
  console.log("================================================================================\n");

  // Step 1: Login Admin & User
  console.log("[1/6] Authenticating test accounts...");
  const rootToken = await loginUser("root", "!WFXU#v1aO7338+");
  const test1Token = await loginUser("test1", "test1");
  console.log(" ✓ Root superadmin & test1 authenticated successfully.");

  // Step 2: Connect WebSockets
  console.log("\n[2/6] Establishing WebSocket handshakes with JWT auth...");
  const adminSocket = await connectSocket(rootToken);
  const userSocket = await connectSocket(test1Token);
  console.log(` ✓ Admin socket connected [ID: ${adminSocket.id}, Room: admin_room]`);
  console.log(` ✓ User socket connected  [ID: ${userSocket.id}, Room: user_1000001]`);

  // Step 3: Raw Ping/Ack Round-trip Latency
  console.log("\n[3/6] Benchmarking raw WebSocket round-trip latency...");
  const pingTimes: number[] = [];
  for (let i = 0; i < 5; i++) {
    const start = performance.now();
    await new Promise<void>((resolve) => {
      adminSocket.emit("ping:check", () => {
        pingTimes.push(performance.now() - start);
        resolve();
      });
    });
  }
  const avgPing = pingTimes.reduce((a, b) => a + b, 0) / pingTimes.length;
  const minPing = Math.min(...pingTimes);
  const maxPing = Math.max(...pingTimes);
  console.log(` ✓ WebSocket RTT: min=${minPing.toFixed(2)}ms, max=${maxPing.toFixed(2)}ms, avg=${avgPing.toFixed(2)}ms (Target < 100ms)`);
  results.push({
    name: "WebSocket Round-Trip Latency",
    latencyMs: avgPing,
    passed: avgPing < 100,
    details: { minPing, maxPing, avgPing },
  });

  // Step 4: Admin Quota Reduction -> Real-time Client Push Benchmark
  console.log("\n[4/6] Benchmarking Instant Quota Reduction Push (<100ms)...");
  {
    // Set quota to 3 first
    await fetch(`${BASE_URL}/api/v1/admin/users/test1`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${rootToken}`,
      },
      body: JSON.stringify({ maxTiktokAccounts: 3 }),
    });

    const eventPromise = waitForEvent(userSocket, "quota:reduced");
    const t0 = performance.now();

    // Trigger quota reduction from 3 -> 1 via REST API
    const resp = await fetch(`${BASE_URL}/api/v1/admin/users/test1`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${rootToken}`,
      },
      body: JSON.stringify({ maxTiktokAccounts: 1 }),
    });

    if (!resp.ok) throw new Error(`Failed to update quota: ${resp.status}`);

    const receivedEvent = await eventPromise;
    const latency = performance.now() - t0;
    console.log(` ✓ [PASS] 'quota:reduced' received by desktop client in ${latency.toFixed(2)}ms!`);
    console.log(`   Payload: newMax=${receivedEvent.newMax}, revokedLeases=${JSON.stringify(receivedEvent.revokedLeaseIds)}`);
    results.push({
      name: "Instant Quota Reduction Push",
      latencyMs: latency,
      passed: latency < 100,
      details: receivedEvent,
    });
  }

  // Step 5: Admin +2h Grace Period -> Real-time License Update Push
  console.log("\n[5/6] Benchmarking Emergency Grace Period (+2h) Real-time Push...");
  {
    const eventPromise = waitForEvent(userSocket, "license:updated");
    const adminEventPromise = waitForEvent(adminSocket, "user:updated");
    const t0 = performance.now();

    const resp = await fetch(`${BASE_URL}/api/v1/admin/users/test1/grace-period`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${rootToken}`,
      },
      body: JSON.stringify({ hours: 2 }),
    });

    if (!resp.ok) throw new Error(`Failed to add grace period: ${resp.status}`);

    const [userEvent, adminEvent] = await Promise.all([eventPromise, adminEventPromise]);
    const latency = performance.now() - t0;
    console.log(` ✓ [PASS] 'license:updated' received by desktop client in ${latency.toFixed(2)}ms!`);
    console.log(`   Payload: expiredAt=${userEvent.expiredAt}, maxAccounts=${userEvent.maxTiktokAccounts}`);
    results.push({
      name: "Emergency Grace Period (+2h) Push",
      latencyMs: latency,
      passed: latency < 100,
      details: { userEvent, adminEvent },
    });
  }

  // Step 5b: Admin Add Days (+30d) -> Real-time License Update Push
  console.log("\n[5b] Benchmarking Admin Add Days (+30 Days) Real-time Push (<100ms)...");
  {
    const eventPromise = waitForEvent(userSocket, "license:updated");
    const adminEventPromise = waitForEvent(adminSocket, "user:updated");
    const t0 = performance.now();

    const resp = await fetch(`${BASE_URL}/api/v1/admin/users/test1`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${rootToken}`,
      },
      body: JSON.stringify({ extendDays: 30 }),
    });

    if (!resp.ok) throw new Error(`Failed to extend days: ${resp.status}`);

    const [userEvent, adminEvent] = await Promise.all([eventPromise, adminEventPromise]);
    const latency = performance.now() - t0;
    console.log(` ✓ [PASS] 'license:updated' received by desktop client in ${latency.toFixed(2)}ms!`);
    console.log(` ✓ [PASS] 'user:updated' received by backoffice in ${latency.toFixed(2)}ms!`);
    console.log(`   New ExpiredAt: ${userEvent.expiredAt}`);
    results.push({
      name: "Admin Add Days (+30d) Real-time Push",
      latencyMs: latency,
      passed: latency < 100,
      details: { userEvent, adminEvent },
    });
  }

  // Step 6: Slot Acquire & Release -> Real-time Admin Live Leases Stream
  console.log("\n[6/6] Benchmarking Slot Acquire/Release Stream to Backoffice Admin Room...");
  {
    const adminEventPromise = waitForEvent(adminSocket, "lease:changed");
    const t0 = performance.now();

    const acquireResp = await fetch(`${BASE_URL}/api/v1/slots/acquire`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${test1Token}`,
      },
      body: JSON.stringify({
        profileFolderName: "RealtimeBenchProfile_01",
        hwid: "TEST_REALTIME_BENCHMARK_HWID",
      }),
    });

    if (!acquireResp.ok) throw new Error(`Failed to acquire slot: ${acquireResp.status}`);
    const acquireData = await acquireResp.json() as { leaseId: string };

    const leaseEvent = await adminEventPromise;
    const latency = performance.now() - t0;
    console.log(` ✓ [PASS] 'lease:changed' (acquired) received in admin_room in ${latency.toFixed(2)}ms!`);
    console.log(`   Lease ID: ${acquireData.leaseId}, Action: ${leaseEvent.action}`);
    results.push({
      name: "Live Lease Stream to Admin Room",
      latencyMs: latency,
      passed: latency < 100,
      details: leaseEvent,
    });

    // Cleanup: release lease
    await fetch(`${BASE_URL}/api/v1/slots/release`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ leaseId: acquireData.leaseId }),
    });
  }

  // Step 7: Socket Keep-Alive Heartbeat Benchmark (Sub-millisecond RTT)
  console.log("\n[7/8] Benchmarking Socket-based Slot Keep-Alive Heartbeat...");
  {
    const acquireResp = await fetch(`${BASE_URL}/api/v1/slots/acquire`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${test1Token}`,
      },
      body: JSON.stringify({
        profileFolderName: "HeartbeatBenchProfile",
        hwid: "TEST_REALTIME_BENCHMARK_HWID",
      }),
    });
    const acquireData = (await acquireResp.json()) as { leaseId: string };

    const t0 = performance.now();
    const ackRes = await new Promise<any>((resolve) => {
      userSocket.emit(
        "slot:heartbeat",
        { leaseId: acquireData.leaseId, hwid: "TEST_REALTIME_BENCHMARK_HWID" },
        (res: any) => {
          resolve(res);
        }
      );
    });
    const latency = performance.now() - t0;
    console.log(` ✓ [PASS] 'slot:heartbeat' confirmed over WebSocket in ${latency.toFixed(2)}ms! (success: ${ackRes?.success})`);
    results.push({
      name: "Socket Keep-Alive Heartbeat RTT",
      latencyMs: latency,
      passed: latency < 100 && ackRes?.success === true,
      details: ackRes,
    });

    // Cleanup
    await fetch(`${BASE_URL}/api/v1/slots/release`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ leaseId: acquireData.leaseId }),
    });
  }

  // Step 8: Live Audit Log Streaming to Admin Room
  console.log("\n[8/8] Benchmarking Live Audit Log Streaming to Admin Room...");
  {
    const auditPromise = waitForEvent(adminSocket, "audit:logged");
    const t0 = performance.now();

    await fetch(`${BASE_URL}/api/v1/admin/users/test2/grace-period`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${rootToken}`,
      },
      body: JSON.stringify({ hours: 1 }),
    });

    const receivedAudit = await auditPromise;
    const latency = performance.now() - t0;
    console.log(` ✓ [PASS] 'audit:logged' received in admin_room in ${latency.toFixed(2)}ms!`);
    results.push({
      name: "Live Audit Log Stream to Admin Room",
      latencyMs: latency,
      passed: latency < 100,
      details: receivedAudit,
    });
  }

  // Cleanup sockets
  adminSocket.disconnect();
  userSocket.disconnect();

  console.log("\n================================================================================");
  console.log("📊 REAL-TIME SOCKET.IO BENCHMARK SUMMARY");
  console.log("================================================================================");
  let allPassed = true;
  for (const r of results) {
    const status = r.passed ? "✅ PASS" : "❌ FAIL (EXCEEDED 100ms)";
    console.log(` ${status.padEnd(25)} | ${r.name.padEnd(35)} | ${r.latencyMs.toFixed(2)} ms`);
    if (!r.passed) allPassed = false;
  }
  console.log("================================================================================");

  if (!allPassed) {
    console.error("\n❌ Some real-time latency checks did not meet the < 100ms requirement.");
    process.exit(1);
  } else {
    console.log("\n🎉 ALL REAL-TIME BENCHMARKS PASSED UNDER 100MS! ULTRA-RESPONSIVE SYSTEM VERIFIED!");
  }
}

runRealtimeBenchmarks().catch((err) => {
  console.error("Benchmark failed with error:", err);
  process.exit(1);
});
