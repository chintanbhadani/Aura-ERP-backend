import https from 'https';
import fs from 'fs';
import path from 'path';
import os from 'os';

let isPolling = false;
let lastUpdateId = 0;

// Resolve maintenance flag path
export const getMaintenanceFlagPath = (): string => {
  const candidatePaths = [
    process.env.MAINTENANCE_FLAG_PATH,
    '/var/www/auraerp/maintenance.flag',
    path.resolve(__dirname, '../../../maintenance.flag'),
    path.resolve(__dirname, '../../maintenance.flag'),
    path.resolve(__dirname, '../maintenance.flag')
  ].filter(Boolean) as string[];

  const found = candidatePaths.find(p => {
    try {
      return fs.existsSync(path.dirname(p));
    } catch {
      return false;
    }
  });

  return found || path.resolve(__dirname, '../../maintenance.flag');
};

export const isMaintenanceActive = (): boolean => {
  try {
    return fs.existsSync(getMaintenanceFlagPath());
  } catch {
    return false;
  }
};

export const setMaintenanceOn = (userInfo?: any): void => {
  const flagPath = getMaintenanceFlagPath();
  const info = {
    lockedAt: new Date().toISOString(),
    lockedBy: userInfo ? `${userInfo.first_name || ''} (@${userInfo.username || 'unknown'})` : 'Admin',
    reason: 'Security Lockdown'
  };
  fs.writeFileSync(flagPath, JSON.stringify(info, null, 2), 'utf8');
};

export const setMaintenanceOff = (): void => {
  const flagPath = getMaintenanceFlagPath();
  if (fs.existsSync(flagPath)) {
    fs.unlinkSync(flagPath);
  }
};

function telegramRequest(token: string, method: string, data: any = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(data);
    const req = https.request({
      hostname: 'api.telegram.org',
      port: 443,
      path: `/bot${token}/${method}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      },
      timeout: 35000
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          if (parsed.ok) resolve(parsed.result);
          else reject(new Error(parsed.description || 'Telegram API error'));
        } catch (err) {
          reject(err);
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    req.write(postData);
    req.end();
  });
}

function sendMessage(token: string, chatId: string | number, text: string): Promise<any> {
  return telegramRequest(token, 'sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML'
  }).catch(err => {
    console.error(`[TelegramBot] Failed to send message to ${chatId}:`, err.message);
  });
}

function getServerStats() {
  const uptimeHours = (os.uptime() / 3600).toFixed(1);
  const totalMem = (os.totalmem() / 1024 / 1024 / 1024).toFixed(1);
  const freeMem = (os.freemem() / 1024 / 1024 / 1024).toFixed(1);
  const usedMem = (Number(totalMem) - Number(freeMem)).toFixed(1);
  return {
    uptime: `${uptimeHours} hours`,
    memory: `${usedMem}GB / ${totalMem}GB (${Math.round((Number(usedMem) / Number(totalMem)) * 100)}% used)`
  };
}

async function handleMessage(token: string, adminChatIds: string[], message: any) {
  const chatId = String(message.chat.id);
  const fromUser = message.from;
  const rawText = (message.text || '').trim();
  const lowerText = rawText.toLowerCase();

  // Extract clean command (works with /down, down, /status, status, etc.)
  let command = lowerText.split(' ')[0].replace(/^\//, '');

  // Normalize command aliases
  if (['down', 'close', 'lockdown', 'stop', 'off'].includes(command)) {
    command = 'down';
  } else if (['up', 'open', 'unlock', 'start_site', 'on', 'resume'].includes(command)) {
    command = 'up';
  } else if (['status', 'check', 'info', 'getme'].includes(command)) {
    command = 'status';
  } else if (['help', 'start'].includes(command)) {
    command = 'help';
  }

  // Security check: Only allow authorized admin
  const isAuthorized = adminChatIds.length === 0 || adminChatIds.includes(chatId);
  if (!isAuthorized) {
    console.warn(`[TelegramBot] Unauthorized attempt from Chat ID ${chatId} (@${fromUser?.username || 'unknown'})`);
    await sendMessage(token, chatId, `⛔ <b>Access Denied</b>\nYour Chat ID (<code>${chatId}</code>) is not authorized.`);
    return;
  }

  console.log(`[TelegramBot] Executing command: ${command} from @${fromUser?.username || chatId}`);

  switch (command) {
    case 'help': {
      const active = isMaintenanceActive();
      const statusText = active 
        ? '🔴 <b>LOCKED DOWN</b> (503 Service Unavailable Active)' 
        : '🟢 <b>ONLINE</b> (Operational)';

      const helpMsg = [
        `🛡️ <b>Aura ERP - Security Lockdown Bot</b>`,
        ``,
        `Current Status: ${statusText}`,
        ``,
        `<b>Available Commands:</b>`,
        `🛑 <code>/down</code> or <code>down</code> - Instantly lock down website (show 503 maintenance page)`,
        `✅ <code>/up</code> or <code>up</code> - Restore website to normal online mode`,
        `📊 <code>/status</code> or <code>status</code> - Check server & site status`,
        ``,
        `Your Chat ID: <code>${chatId}</code>`
      ].join('\n');

      await sendMessage(token, chatId, helpMsg);
      break;
    }

    case 'down': {
      if (isMaintenanceActive()) {
        await sendMessage(token, chatId, `⚠️ <b>Aura ERP is ALREADY LOCKED DOWN!</b>\n\nVisitors are currently seeing the <i>503 Service Unavailable</i> maintenance screen.\n\nSend <code>/up</code> to restore access.`);
        return;
      }

      try {
        setMaintenanceOn(fromUser);
        console.log(`🚨 [TelegramBot] LOCKDOWN ACTIVATED by @${fromUser?.username || chatId}`);

        const msg = [
          `🚨 <b>WEBSITE LOCKED DOWN SUCCESSFULLY</b>`,
          `━━━━━━━━━━━━━━━━━━━━━━━━━`,
          `• <b>Status:</b> 🔴 Offline / Maintenance Active`,
          `• <b>HTTP Code:</b> 503 Service Unavailable`,
          `• <b>Action:</b> All public access & API routes blocked`,
          `• <b>Activated By:</b> @${fromUser?.username || fromUser?.first_name || chatId}`,
          `• <b>Time:</b> ${new Date().toLocaleString()}`,
          ``,
          `Visitors now see the maintenance screen. Send <code>/up</code> to restore access.`
        ].join('\n');

        await sendMessage(token, chatId, msg);
      } catch (err: any) {
        console.error('[TelegramBot] Failed to set maintenance flag:', err);
        await sendMessage(token, chatId, `❌ <b>Failed to activate lockdown:</b>\n<code>${err.message}</code>`);
      }
      break;
    }

    case 'up': {
      if (!isMaintenanceActive()) {
        await sendMessage(token, chatId, `ℹ️ <b>Aura ERP is ALREADY ONLINE!</b>\n\nNormal access is active.\n\nSend <code>/down</code> to shut down.`);
        return;
      }

      try {
        setMaintenanceOff();
        console.log(`✅ [TelegramBot] LOCKDOWN DEACTIVATED by @${fromUser?.username || chatId}`);

        const msg = [
          `🟢 <b>WEBSITE RESTORED ONLINE</b>`,
          `━━━━━━━━━━━━━━━━━━━━━━━━━`,
          `• <b>Status:</b> 🟢 Online & Fully Operational`,
          `• <b>Action:</b> Maintenance mode disabled`,
          `• <b>Restored By:</b> @${fromUser?.username || fromUser?.first_name || chatId}`,
          `• <b>Time:</b> ${new Date().toLocaleString()}`,
          ``,
          `Aura ERP is now accessible to all users.`
        ].join('\n');

        await sendMessage(token, chatId, msg);
      } catch (err: any) {
        console.error('[TelegramBot] Failed to remove maintenance flag:', err);
        await sendMessage(token, chatId, `❌ <b>Failed to deactivate lockdown:</b>\n<code>${err.message}</code>`);
      }
      break;
    }

    case 'status': {
      const active = isMaintenanceActive();
      const stats = getServerStats();
      const flagPath = getMaintenanceFlagPath();

      let flagDetails = '';
      if (active) {
        try {
          const content = JSON.parse(fs.readFileSync(flagPath, 'utf8'));
          flagDetails = `\n• <b>Locked Since:</b> ${content.lockedAt || 'N/A'}\n• <b>Locked By:</b> ${content.lockedBy || 'Admin'}`;
        } catch {
          flagDetails = `\n• <b>Locked:</b> Active on server`;
        }
      }

      const msg = [
        `📊 <b>Aura ERP System Status</b>`,
        `━━━━━━━━━━━━━━━━━━━━━━━━━`,
        `• <b>Site Status:</b> ${active ? '🔴 LOCKED DOWN (503 Active)' : '🟢 ONLINE (Normal)'}`,
        flagDetails,
        `• <b>Server Memory:</b> ${stats.memory}`,
        `• <b>Server Uptime:</b> ${stats.uptime}`,
        ``,
        active 
          ? `👉 Send <code>/up</code> to restore site.` 
          : `👉 Send <code>/down</code> to shut down site.`
      ].filter(Boolean).join('\n');

      await sendMessage(token, chatId, msg);
      break;
    }

    default:
      await sendMessage(token, chatId, `❓ Unknown command: <code>${rawText}</code>\n\nSend <code>/help</code> or <code>/status</code> to see options.`);
  }
}

async function pollUpdates(token: string, adminChatIds: string[]) {
  if (!isPolling) return;

  try {
    const updates = await telegramRequest(token, 'getUpdates', {
      offset: lastUpdateId + 1,
      timeout: 25,
      allowed_updates: ['message']
    });

    if (Array.isArray(updates)) {
      for (const update of updates) {
        lastUpdateId = update.update_id;
        if (update.message && update.message.text) {
          await handleMessage(token, adminChatIds, update.message);
        }
      }
    }
  } catch (err: any) {
    if (err.message && !err.message.includes('timeout')) {
      console.warn('[TelegramBot] Polling warning:', err.message);
    }
    await new Promise(r => setTimeout(r, 2000));
  }

  // Continue polling loop
  if (isPolling) {
    setImmediate(() => pollUpdates(token, adminChatIds));
  }
}

/**
 * Initialize and start the Telegram Lockdown Bot in the background
 */
export function startTelegramLockdownBot(): void {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const adminChatIds = (process.env.TELEGRAM_ADMIN_CHAT_ID || '')
    .split(',')
    .map(id => id.trim())
    .filter(Boolean);

  if (!token) {
    console.log('[TelegramBot] No TELEGRAM_BOT_TOKEN configured, bot disabled.');
    return;
  }

  if (isPolling) {
    console.log('[TelegramBot] Bot already running.');
    return;
  }

  console.log('[TelegramBot] Connecting to Telegram API...');
  telegramRequest(token, 'getMe')
    .then(botInfo => {
      console.log(`[TelegramBot] ✅ Connected as @${botInfo.username} (${botInfo.first_name})`);
      console.log(`[TelegramBot] 🔒 Authorized Admin ID: ${adminChatIds.join(', ') || 'ANY'}`);
      isPolling = true;
      pollUpdates(token, adminChatIds);
    })
    .catch(err => {
      console.error('[TelegramBot] Failed to connect:', err.message);
      console.log('[TelegramBot] Will retry in 10 seconds...');
      setTimeout(() => startTelegramLockdownBot(), 10000);
    });
}

export function stopTelegramLockdownBot(): void {
  isPolling = false;
}

