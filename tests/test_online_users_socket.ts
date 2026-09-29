import { io } from "socket.io-client";

const SERVER_URL = "http://210.246.215.66:8001";

async function login(username: string, pass: string): Promise<string> {
  const resp = await fetch(`${SERVER_URL}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username,
      password: pass,
      hwid: "TEST-ONLINE-HWID-99",
      deviceName: "Test Runner Device",
    }),
  });
  const data = (await resp.json()) as any;
  if (!resp.ok) throw new Error(data.error || "Login failed");
  return data.accessToken || data.token;
}

async function runTest() {
  console.log("=== Starting User Online & Remote Log Socket E2E Test ===");

  // 1. Login as admin first
  console.log("[1] Logging in as admin 'root'...");
  const adminToken = await login("root", "!WFXU#v1aO7338+");
  console.log("    Admin token acquired.");

  // Reset devices for test1
  console.log("[1.1] Resetting devices for 'test1'...");
  await fetch(`${SERVER_URL}/api/v1/admin/users/1000001/reset-devices`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${adminToken}`,
      "Content-Type": "application/json",
    },
  });

  // 2. Login as test user
  console.log("[2] Logging in as user 'test1'...");
  const userToken = await login("test1", "test1");
  console.log("    User token acquired.");

  // 3. Connect Client Socket
  console.log("[3] Connecting client socket for 'test1'...");
  const clientSocket = io(SERVER_URL, {
    auth: { token: userToken },
    transports: ["websocket"],
  });

  await new Promise<void>((resolve, reject) => {
    clientSocket.on("connect", () => {
      console.log(`    Client socket connected: ${clientSocket.id}`);
      resolve();
    });
    clientSocket.on("connect_error", (err) => reject(err));
  });

  // Client listens for cmd:get_instance_logs
  clientSocket.on("cmd:get_instance_logs", (data: any) => {
    console.log(`    [Client] Received cmd:get_instance_logs:`, data);
    const reply = {
      requestId: data.requestId,
      success: true,
      profileFolderName: data.profileFolderName,
      cdpPort: data.cdpPort,
      fileName: `${data.profileFolderName}_debug.log`,
      logs: `[2026-09-20 17:40:00] [INFO] TikTok Studio started successfully.\n[2026-09-20 17:40:05] [Network] CDP Attached to port ${data.cdpPort}\n[2026-09-20 17:40:10] [Captcha] Jigsaw Captcha detected on screen.\n[2026-09-20 17:40:12] [CaptchaSolver] Successfully solved puzzle in 1.4s!`,
      timestamp: new Date().toISOString(),
    };
    clientSocket.emit("client:instance_logs_response", reply);
    console.log(`    [Client] Emitted client:instance_logs_response.`);
  });

  // 4. Client reports instances
  console.log("[4] Client reporting live instances...");
  clientSocket.emit("client:instances_report", {
    appVersion: "0.1.1",
    hwid: "TEST-ONLINE-HWID-99",
    hostname: "DESKTOP-TEST-PC",
    instances: [
      {
        name: "Acc01_Live",
        profileFolderName: "Acc01",
        cdpPort: 9221,
        status: "Running",
        processId: 12345,
        startedAt: new Date(Date.now() - 3600000).toISOString(),
        uptimeSeconds: 3600,
        proxy: "103.123.45.67:8080",
        isLoggedIn: true,
        channelName: "Gaming Studio Thailand",
        channelHandle: "gaming_thailand",
        activeLeaseId: "lease_test_01",
        captcha: {
          hasAlert: false,
          isSolving: false,
          typeDescription: "None",
          countdown: "00:00",
          count: 0,
        },
      },
    ],
  });

  // 5. Connect Admin Socket
  console.log("[5] Connecting admin socket for 'root'...");
  const adminSocket = io(SERVER_URL, {
    auth: { token: adminToken },
    transports: ["websocket"],
  });

  await new Promise<void>((resolve, reject) => {
    adminSocket.on("connect", () => {
      console.log(`    Admin socket connected: ${adminSocket.id}`);
      resolve();
    });
    adminSocket.on("connect_error", (err) => reject(err));
  });

  // Wait 1 sec for server session sync
  await new Promise((r) => setTimeout(r, 1000));

  // 6. Admin queries online users
  console.log("[6] Admin querying online users via socket...");
  const onlineUsersRes = await new Promise<any>((resolve) => {
    adminSocket.emit("admin:get_online_users", (res: any) => resolve(res));
  });

  console.log(`    Online users count: ${onlineUsersRes?.users?.length || 0}`);
  const testUserEntry = onlineUsersRes?.users?.find((u: any) => u.username === "test1");
  if (!testUserEntry) {
    throw new Error("test1 was not found in online users list!");
  }
  console.log(`    Found user 'test1' with ${testUserEntry.instances?.length} instance(s).`);
  console.log(`    Instance 0: ${testUserEntry.instances[0]?.name} (@${testUserEntry.instances[0]?.channelHandle}) CDP:${testUserEntry.instances[0]?.cdpPort}`);

  // 7. Admin fetches instance logs remotely via socket
  console.log("[7] Admin requesting remote instance logs via socket...");
  const logResponse = await new Promise<any>((resolve) => {
    adminSocket.emit(
      "admin:fetch_instance_logs",
      {
        targetUserId: testUserEntry.userId,
        targetSocketId: testUserEntry.socketId,
        profileFolderName: "Acc01",
        cdpPort: 9221,
      },
      (res: any) => resolve(res)
    );
  });

  console.log("    Received log response:", {
    success: logResponse?.success,
    fileName: logResponse?.fileName,
    logLength: logResponse?.logs?.length,
  });

  if (!logResponse?.success || !logResponse?.logs) {
    throw new Error(`Failed to retrieve logs: ${JSON.stringify(logResponse)}`);
  }

  console.log("\n--- Sample Log Output Received by Admin ---");
  console.log(logResponse.logs);
  console.log("-------------------------------------------\n");

  // Cleanup
  clientSocket.disconnect();
  adminSocket.disconnect();

  console.log("=== [SUCCESS] All User Online & Remote Log Socket tests passed! ===");
}

runTest().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
