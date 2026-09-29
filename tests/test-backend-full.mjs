import http from "node:http";
import mongoose from "mongoose";

const PORT = 3009; // Use port 3009 for test server to avoid conflicts
process.env.PORT = String(PORT);
process.env.NODE_ENV = "test";
process.env.MONGODB_URI = "mongodb://127.0.0.1:27017/tiktok_sandbox";
process.env.ROOT_USERNAME = "root";
process.env.ROOT_PASSWORD = "root123456";

// Dynamically import the compiled modules or tsx
const { connectDb, disconnectDb } = await import("../dist/config/db.js");
const { ensureRootUser, ensureTestUser } = await import("../dist/services/bootstrap.js");
const { buildApp } = await import("../dist/app.js");
const { User } = await import("../dist/models/User.js");
const { RefreshToken } = await import("../dist/models/RefreshToken.js");
const { ActiveLease } = await import("../dist/models/ActiveLease.js");
const { CaptchaLog } = await import("../dist/models/CaptchaLog.js");
const { SecurityEvent } = await import("../dist/models/SecurityEvent.js");

const BASE_URL = `http://127.0.0.1:${PORT}`;

let server;
let passCount = 0;
let failCount = 0;

function assert(condition, message) {
  if (!condition) {
    console.error(`❌ FAIL: ${message}`);
    failCount++;
    throw new Error(message);
  } else {
    console.log(`✅ PASS: ${message}`);
    passCount++;
  }
}

async function request(path, options = {}) {
  const url = `${BASE_URL}${path}`;
  const response = await fetch(url, {
    method: options.method || "GET",
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }

  return { status: response.status, body: json };
}

async function runTests() {
  console.log("==================================================");
  console.log("🚀 Starting Full Backend & Database Integration Tests");
  console.log("==================================================");

  // 1. Connect MongoDB & Bootstrap
  await connectDb();
  await ensureRootUser();
  await ensureTestUser();

  const app = buildApp();
  server = app.listen(PORT);
  await new Promise((resolve) => setTimeout(resolve, 500));

  try {
    // Test 1: Root User in MongoDB
    const rootUser = await User.findOne({ username: "root" });
    assert(rootUser !== null, "Root user exists in MongoDB");
    assert(rootUser.isSystemRoot === true, "Root user isSystemRoot is true");
    assert(rootUser.role === "superadmin", "Root user role is superadmin");
    assert(rootUser.license.maxTiktokAccounts === 999, "Root user maxTiktokAccounts is 999");

    // Test 2: Root Login
    const rootLoginRes = await request("/api/v1/auth/login", {
      method: "POST",
      body: { username: "root", password: "root123456", hwid: "ROOT-HWID-01" },
    });
    assert(rootLoginRes.status === 200, "Root login returns 200 OK");
    assert(typeof rootLoginRes.body.accessToken === "string", "Root receives accessToken");
    assert(typeof rootLoginRes.body.refreshToken === "string", "Root receives refreshToken");
    const rootToken = rootLoginRes.body.accessToken;

    // Test 3: Test User Login
    const testLoginRes = await request("/api/v1/auth/login", {
      method: "POST",
      body: { username: "test", password: "test", hwid: "TEST-HWID-01" },
    });
    assert(testLoginRes.status === 200, "Test user login returns 200 OK");
    assert(testLoginRes.body.maxTiktokAccounts === 10, "Test user maxTiktokAccounts returned");
    const testToken = testLoginRes.body.accessToken;
    const testRefreshToken = testLoginRes.body.refreshToken;

    // Test 4: Auth /me
    const meRes = await request("/api/v1/auth/me", {
      headers: { Authorization: `Bearer ${testToken}` },
    });
    assert(meRes.status === 200, "GET /me returns 200 OK");
    assert(meRes.body.username === "test", "GET /me returns correct username");
    assert(meRes.body.license.deviceLimit === 5, "GET /me returns deviceLimit");

    // Test 5: Refresh Token Rotation
    const refreshRes = await request("/api/v1/auth/refreshToken", {
      method: "POST",
      body: { refreshToken: testRefreshToken },
    });
    assert(refreshRes.status === 200, "POST /refreshToken returns 200 OK");
    assert(typeof refreshRes.body.accessToken === "string", "Rotated new accessToken returned");
    assert(typeof refreshRes.body.refreshToken === "string", "Rotated new refreshToken returned");

    // Test 6: Root Protection Middleware (Prevent DELETE and Suspend)
    const deleteRootRes = await request(`/api/v1/admin/users/${rootUser._id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${rootToken}` },
    });
    assert(deleteRootRes.status === 403, "DELETE Root is blocked with 403 Forbidden");

    const suspendRootRes = await request(`/api/v1/admin/users/${rootUser._id}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${rootToken}` },
      body: { status: "suspended" },
    });
    assert(suspendRootRes.status === 403, "Suspending Root is blocked with 403 Forbidden");

    // Test 7: Admin CRUD User
    const createSubUserRes = await request("/api/v1/admin/users", {
      method: "POST",
      headers: { Authorization: `Bearer ${rootToken}` },
      body: {
        username: "client_user1",
        password: "password123",
        role: "user",
        maxTiktokAccounts: 3,
        deviceLimit: 2,
      },
    });
    assert(createSubUserRes.status === 201, "Admin creates user returns 201 Created");
    const createdUserId = createSubUserRes.body.user.userId;

    const listUsersRes = await request("/api/v1/admin/users", {
      headers: { Authorization: `Bearer ${rootToken}` },
    });
    assert(listUsersRes.status === 200, "Admin GET /users returns 200 OK");
    assert(listUsersRes.body.users.length >= 2, "Admin user list contains created users");

    // Update user quota
    const updateRes = await request(`/api/v1/admin/users/${createdUserId}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${rootToken}` },
      body: { maxTiktokAccounts: 5 },
    });
    assert(updateRes.status === 200, "Admin PUT /users/:id returns 200 OK");
    assert(updateRes.body.user.license.maxTiktokAccounts === 5, "Updated maxTiktokAccounts is 5");

    // Reset devices
    const resetDevicesRes = await request(`/api/v1/admin/users/${createdUserId}/reset-devices`, {
      method: "POST",
      headers: { Authorization: `Bearer ${rootToken}` },
    });
    assert(resetDevicesRes.status === 200, "Admin reset-devices returns 200 OK");

    // Test 8: Slots Acquire & Concurrency Limit
    // Login as the created user
    const clientLogin = await request("/api/v1/auth/login", {
      method: "POST",
      body: { username: "client_user1", password: "password123", hwid: "CLIENT-HWID-01" },
    });
    const clientToken = clientLogin.body.accessToken;

    // Acquire slot 1
    const slot1 = await request("/api/v1/slots/acquire", {
      method: "POST",
      headers: { Authorization: `Bearer ${clientToken}` },
      body: { profileFolderName: "Acc01", hwid: "CLIENT-HWID-01" },
    });
    assert(slot1.status === 200, "Slots acquire slot 1 returns 200 OK");
    assert(typeof slot1.body.leaseId === "string", "Valid leaseId returned for slot 1");
    const leaseId1 = slot1.body.leaseId;

    // Heartbeat slot 1
    const hbRes = await request("/api/v1/slots/heartbeat", {
      method: "POST",
      body: { leaseId: leaseId1, hwid: "CLIENT-HWID-01" },
    });
    assert(hbRes.status === 200, "Slots heartbeat returns 200 OK");

    // Acquire remaining slots up to 5
    await request("/api/v1/slots/acquire", {
      method: "POST",
      headers: { Authorization: `Bearer ${clientToken}` },
      body: { profileFolderName: "Acc02", hwid: "CLIENT-HWID-01" },
    });
    await request("/api/v1/slots/acquire", {
      method: "POST",
      headers: { Authorization: `Bearer ${clientToken}` },
      body: { profileFolderName: "Acc03", hwid: "CLIENT-HWID-01" },
    });
    await request("/api/v1/slots/acquire", {
      method: "POST",
      headers: { Authorization: `Bearer ${clientToken}` },
      body: { profileFolderName: "Acc04", hwid: "CLIENT-HWID-01" },
    });
    await request("/api/v1/slots/acquire", {
      method: "POST",
      headers: { Authorization: `Bearer ${clientToken}` },
      body: { profileFolderName: "Acc05", hwid: "CLIENT-HWID-01" },
    });

    // Attempt 6th slot (limit is 5) -> should be rejected 403
    const slot6 = await request("/api/v1/slots/acquire", {
      method: "POST",
      headers: { Authorization: `Bearer ${clientToken}` },
      body: { profileFolderName: "Acc06", hwid: "CLIENT-HWID-01" },
    });
    assert(slot6.status === 403, "Slot 6 exceeds quota and returns 403 Forbidden");

    // Release slot 1
    const releaseRes = await request("/api/v1/slots/release", {
      method: "POST",
      body: { leaseId: leaseId1 },
    });
    assert(releaseRes.status === 200, "Slots release returns 200 OK");

    // Now slot 6 should be acquirable
    const slot6Retry = await request("/api/v1/slots/acquire", {
      method: "POST",
      headers: { Authorization: `Bearer ${clientToken}` },
      body: { profileFolderName: "Acc06", hwid: "CLIENT-HWID-01" },
    });
    assert(slot6Retry.status === 200, "Slot 6 successfully acquired after release");

    // Test 9: Captcha verifyActiveLease Gatekeeper
    // A. Request without X-Instance-Lease should fail with 403
    const captchaNoLease = await request("/captcha/slide", {
      method: "POST",
      headers: { Authorization: `Bearer ${clientToken}` },
      body: { image: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==" },
    });
    assert(captchaNoLease.status === 403, "Captcha rejected 403 without X-Instance-Lease");

    // B. Request with invalid or expired lease should fail with 403
    const captchaFakeLease = await request("/captcha/slide", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${clientToken}`,
        "X-Instance-Lease": "lease_fake999",
      },
      body: { image: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==" },
    });
    assert(captchaFakeLease.status === 403, "Captcha rejected 403 with fake lease");

    // C. Request with valid active lease should pass verifyActiveLease
    const activeLeaseObj = await ActiveLease.findOne({ userId: createdUserId });
    const captchaValidLease = await request("/captcha/slide", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${clientToken}`,
        "X-Instance-Lease": activeLeaseObj.leaseId,
      },
      body: { image: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==" },
    });
    // Even if 1x1 image returns 500 invalid slide position, it PASSED verifyActiveLease (not 403!)
    assert(captchaValidLease.status !== 403, "Captcha passed verifyActiveLease with valid lease");

    // Check that CaptchaLog was created in MongoDB
    await new Promise((resolve) => setTimeout(resolve, 300));
    const logDoc = await CaptchaLog.findOne({ userId: createdUserId });
    assert(logDoc !== null, "CaptchaLog recorded in MongoDB");
    assert(logDoc.captchaType === "slide", "CaptchaLog captchaType is slide");

    // Clean up created test user
    await User.deleteOne({ userId: createdUserId });
    await ActiveLease.deleteMany({ userId: createdUserId });
    await RefreshToken.deleteMany({ userId: createdUserId });
    await CaptchaLog.deleteMany({ userId: createdUserId });

    console.log("==================================================");
    console.log(`🎉 ALL TESTS PASSED! (${passCount}/${passCount + failCount})`);
    console.log("==================================================");
  } finally {
    if (server) server.close();
    await disconnectDb();
  }
}

runTests().catch((err) => {
  console.error("Test execution error:", err);
  process.exit(1);
});
