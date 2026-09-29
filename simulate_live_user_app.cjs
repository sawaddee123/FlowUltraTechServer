const { io } = require('socket.io-client');

const SERVER_URL = 'http://210.246.215.66:8001';

async function run() {
  console.log('[CLIENT SIM] Logging in...');
  const loginRes = await fetch(`${SERVER_URL}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: 'root',
      password: '!WFXU#v1aO7338+',
      hwid: 'LIVE-CLIENT-PC-TH99'
    })
  }).then(r => r.json());

  if (!loginRes.accessToken) {
    console.error('[CLIENT SIM] Login failed:', loginRes);
    process.exit(1);
  }

  const token = loginRes.accessToken;
  console.log('[CLIENT SIM] Login successful. Acquiring Slot Lease for Acc01...');

  // Acquire Slot Lease
  const leaseRes = await fetch(`${SERVER_URL}/api/v1/slots/acquire`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({
      profileFolderName: 'Acc01_OfficialStore',
      hwid: 'LIVE-CLIENT-PC-TH99'
    })
  }).then(r => r.json());

  console.log('[CLIENT SIM] Slot Lease acquired:', leaseRes);
  const activeLeaseId = leaseRes.leaseId || 'lease-live-default';

  // Connect via Socket.io with clientType: desktop
  console.log('[CLIENT SIM] Connecting via Socket.io as desktop client...');
  const socket = io(SERVER_URL, {
    auth: { token, clientType: 'desktop' },
    query: { clientType: 'desktop' },
    transports: ['websocket']
  });

  socket.on('connect', () => {
    console.log('[CLIENT SIM] Socket connected with id:', socket.id);

    const payload = {
      appVersion: '1.1.0',
      hwid: 'LIVE-CLIENT-PC-TH99',
      hostname: 'TH-STREAMING-RIG-01',
      isProgramOpen: true,
      runningCount: 1,
      totalCount: 2,
      instances: [
        {
          name: 'TikTok LIVE Official Store',
          accountName: 'TikTok LIVE Official Store',
          profileFolderName: 'Acc01_OfficialStore',
          cdpPort: 9222,
          status: 'Running',
          isTikTokRunning: true,
          processId: 10452,
          startedAt: new Date(Date.now() - 360000).toISOString(),
          uptimeSeconds: 360,
          proxy: 'Direct',
          isLoggedIn: true,
          channelName: 'FlowUltra Official Store',
          channelHandle: '@flowultra_th',
          channelAvatar: 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=100&auto=format&fit=crop',
          activeLeaseId: activeLeaseId,
          captcha: {
            hasAlert: false,
            isSolving: false,
            typeDescription: '-',
            countdown: '00:00',
            count: 0
          }
        },
        {
          name: 'TikTok Backup Channel',
          accountName: 'TikTok Backup Channel',
          profileFolderName: 'Acc02_Backup',
          cdpPort: 9223,
          status: 'Stopped',
          isTikTokRunning: false,
          proxy: 'Direct',
          isLoggedIn: false,
          channelName: '',
          channelHandle: '',
          activeLeaseId: '',
          captcha: {
            hasAlert: false,
            isSolving: false,
            typeDescription: '-',
            countdown: '00:00',
            count: 0
          }
        }
      ]
    };

    console.log('[CLIENT SIM] Emitting client:instances_report...');
    socket.emit('client:instances_report', payload);

    // Keep lease alive every 10s
    setInterval(() => {
      socket.emit('slot:heartbeat', { leaseId: activeLeaseId, hwid: 'LIVE-CLIENT-PC-TH99' }, (ack) => {
        console.log('[CLIENT SIM] Heartbeat ack:', ack?.success, 'expiresAt:', ack?.expiresAt);
      });
    }, 10000);
    // Handle remote log requests from Backoffice admin
    socket.on('cmd:get_instance_logs', (req) => {
      console.log('[CLIENT SIM] Received cmd:get_instance_logs:', req);
      const fs = require('fs');
      const path = require('path');
      const appData = process.env.APPDATA || '';
      const logsDir = path.join(appData, 'FlowUltraTech', 'Logs');
      let logContent = '';
      let foundFileName = `${req.profileFolderName || 'Acc01'}_debug.log`;

      try {
        const candidateFiles = [
          path.join(logsDir, `${req.profileFolderName}_debug.log`),
          path.join(logsDir, 'Acc01_debug.log'),
          path.join(logsDir, 'TestAcc01_debug.log'),
          path.join(logsDir, 'IntegrationTestAcc_debug.log')
        ];

        for (const f of candidateFiles) {
          if (fs.existsSync(f)) {
            const raw = fs.readFileSync(f, 'utf8');
            const lines = raw.split(/\r?\n/);
            const maxL = req.maxLines || 2000;
            logContent = lines.slice(-maxL).join('\n');
            foundFileName = path.basename(f);
            break;
          }
        }
      } catch (err) {
        console.error('[CLIENT SIM] Failed to read log from disk:', err);
      }

      if (!logContent) {
        const nowIso = new Date().toISOString();
        logContent = [
          `[${nowIso}] [INFO ] [TikTok LIVE Studio] Process started (PID: 10452, Path: C:\\Users\\Prayu\\AppData\\Local\\TikTok LIVE Studio\\TikTok LIVE Studio.exe)`,
          `[${nowIso}] [INFO ] [CDP] DevTools listening on ws://127.0.0.1:9222/devtools/browser/78bfa1d9-4322-488b-a5d9-1c91ff38992e`,
          `[${nowIso}] [INFO ] [Profile] Loaded profile: ${req.profileFolderName || 'Acc01_OfficialStore'} (Port: ${req.cdpPort || 9222})`,
          `[${nowIso}] [INFO ] [Session] Profile bound successfully to user session`,
          `[${nowIso}] [INFO ] [LiveChat] Connected to @flowultra_th live broadcast room (Room ID: 74182940192)`,
          `[${nowIso}] [INFO ] [Chat] [LiveStatus] กำลังเชื่อมต่อ @flowultra_th...`,
          `[${nowIso}] [INFO ] [Chat] เปลี่ยนสถานะการมอนิเตอร์แชทสดเป็น: เปิดทำงาน`,
          `[${nowIso}] [INFO ] [Watchdog] Heartbeat active for lease: ${activeLeaseId}`,
          `[${nowIso}] [INFO ] [StreamMonitor] Video FPS: 60.0 | Bitrate: 6240 kbps | Dropped frames: 0 (0.0%)`,
          `[${nowIso}] [INFO ] [Captcha] TikTok security challenge check passed: clean session`,
          `[${nowIso}] [INFO ] [Heartbeat] Slot lease extended successfully`
        ].join('\n');
      }

      const reply = {
        requestId: req.requestId,
        success: true,
        profileFolderName: req.profileFolderName,
        accountName: req.accountName,
        cdpPort: req.cdpPort,
        fileName: foundFileName,
        logs: logContent,
        lineCount: logContent.split('\n').length,
        timestamp: new Date().toISOString()
      };

      console.log(`[CLIENT SIM] Replying client:instance_logs_response with ${reply.lineCount} lines for requestId: ${req.requestId}`);
      socket.emit('client:instance_logs_response', reply);
    });

    socket.on('disconnect', (reason) => {
      console.log('[CLIENT SIM] Disconnected:', reason);
    });
  });

  // Keep script running for 300s
  setTimeout(async () => {
    console.log('[CLIENT SIM] Cleaning up lease...');
    await fetch(`${SERVER_URL}/api/v1/slots/release`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ leaseId: activeLeaseId })
    });
    socket.disconnect();
    process.exit(0);
  }, 300000);
}

run().catch(err => {
  console.error('[CLIENT SIM] Fatal error:', err);
  process.exit(1);
});
