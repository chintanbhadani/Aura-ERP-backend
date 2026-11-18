/**
 * Aura ERP - Emergency Telegram Lockdown Bot
 * 
 * Allows the administrator to instantly shut down (maintenance mode 503) 
 * or restore the website with a single Telegram message.
 * 
 * Zero external npm dependencies (uses native Node.js https module).
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

// Load .env if present
const envPath = path.resolve(__dirname, '../.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  envContent.split('\n').forEach(line => {
    const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
    if (match) {
      const key = match[1];
      let value = match[2] || '';
      if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
      if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
      if (!process.env[key]) process.env[key] = value.trim();
    }
  });
}

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT_IDS = (process.env.TELEGRAM_ADMIN_CHAT_ID || '')
  .split(',')
  .map(id => id.trim())
  .filter(Boolean);

// Detect flag path
const candidatePaths = [
  process.env.MAINTENANCE_FLAG_PATH,
  '/var/www/auraerp/maintenance.flag',
  path.resolve(__dirname, '../../maintenance.flag'),
  path.resolve(__dirname, '../maintenance.flag')
].filter(Boolean);

let FLAG_PATH = candidatePaths.find(p => {
  try {
    const dir = path.dirname(p);
    return fs.existsSync(dir);
  } catch (e) {
    return false;
  }
}) || path.resolve(__dirname, '../../maintenance.flag');

console.log('--------------------------------------------------');
console.log('🤖 Aura ERP Telegram Security Bot starting...');
console.log(`📁 Maintenance Flag Path: ${FLAG_PATH}`);
console.log(`🔒 Authorized Admin Chat IDs: ${ADMIN_CHAT_IDS.length > 0 ? ADMIN_CHAT_IDS.join(', ') : '⚠️ NONE CONFIGURED'}`);

if (!BOT_TOKEN) {
  console.error('\n❌ ERROR: TELEGRAM_BOT_TOKEN is not set in Backend/.env!');
  console.error('Please configure TELEGRAM_BOT_TOKEN and TELEGRAM_ADMIN_CHAT_ID.');
  console.log('Exiting in 10s...');
  setTimeout(() => process.exit(1), 10000);
  return;
}

// Telegram API Helper
function telegramRequest(method, data = {}) {
  console.log(" telegramRequest :: ", method, data);
  
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(data);
    const options = {
      hostname: 'api.telegram.org',
      port: 443,
      path: `/bot${BOT_TOKEN}/${method}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      },
      timeout: 35000
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          if (parsed.ok) {
            resolve(parsed.result);
          } else {
            reject(new Error(parsed.description || 'Telegram API error'));
          }
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

function sendMessage(chatId, text) {
  return telegramRequest('sendMessage', {
    chat_id: chatId,
    text: text,
    parse_mode: 'HTML'
  }).catch(err => {
    console.error(`Failed to send message to ${chatId}:`, err.message);
  });
}

// Maintenance flag helpers
function isMaintenanceActive() {
  return fs.existsSync(FLAG_PATH);
}

function setMaintenanceOn(user) {
  const info = {
    lockedAt: new Date().toISOString(),
    lockedBy: user ? `${user.first_name || ''} (@${user.username || 'unknown'})` : 'Admin',
    reason: 'Security Lockdown'
  };
  fs.writeFileSync(FLAG_PATH, JSON.stringify(info, null, 2), 'utf8');
}

function setMaintenanceOff() {
  if (fs.existsSync(FLAG_PATH)) {
    fs.unlinkSync(FLAG_PATH);
  }
}

// Format server uptime & RAM
function getServerStats() {
  const uptimeHours = (os.uptime() / 3600).toFixed(1);
  const totalMem = (os.totalmem() / 1024 / 1024 / 1024).toFixed(1);
  const freeMem = (os.freemem() / 1024 / 1024 / 1024).toFixed(1);
  const usedMem = (totalMem - freeMem).toFixed(1);
  return {
    uptime: `${uptimeHours} hours`,
    memory: `${usedMem}GB / ${totalMem}GB (${Math.round((usedMem / totalMem) * 100)}% used)`
  };
}

// Message Dispatcher
async function handleMessage(message) {
  const chatId = String(message.chat.id);
  const fromUser = message.from;
  const rawText = (message.text || '').trim();
  const lowerText = rawText.toLowerCase();

  // 1. Authorization check
  const isAuthorized = ADMIN_CHAT_IDS.length === 0 || ADMIN_CHAT_IDS.includes(chatId);
  if (!isAuthorized) {
    console.warn(`⚠️ Unauthorized access attempt from Chat ID ${chatId} (@${fromUser?.username || 'unknown'})`);
    await sendMessage(chatId, `⛔ <b>Access Denied</b>\nYour Chat ID (<code>${chatId}</code>) is not authorized.`);
    return;
  }

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

  // If no admin configured, notify the user of their chat id so they can save it!
  if (ADMIN_CHAT_IDS.length === 0) {
    console.log(`ℹ️ First contact from Chat ID: ${chatId}. Add TELEGRAM_ADMIN_CHAT_ID=${chatId} to .env to restrict access.`);
  }

  console.log(`[Bot Command] ${rawText} -> parsed as "${command}" from @${fromUser?.username || chatId}`);

  // 2. Handle commands
  switch (command) {
    case 'help': {
      const active = isMaintenanceActive();
      const statusText = active 
        ? '🔴 <b>LOCKED DOWN</b> (503 Service Unavailable)' 
        : '🟢 <b>ONLINE</b> (Operational)';

      const helpMsg = [
        `🛡️ <b>Aura ERP - Security Lockdown Bot</b>`,
        ``,
        `Current Status: ${statusText}`,
        ``,
        `<b>Available Commands:</b>`,
        `🛑 <code>/down</code> or <code>/close</code> - Instantly lock down website (show 503 maintenance page)`,
        `✅ <code>/up</code> or <code>/open</code> - Restore website to normal online mode`,
        `📊 <code>/status</code> - Check current server & site status`,
        ``,
        `Your Chat ID: <code>${chatId}</code>`
      ].join('\n');

      await sendMessage(chatId, helpMsg);
      break;
    }

    case 'down': {
      if (isMaintenanceActive()) {
        await sendMessage(chatId, `⚠️ <b>Aura ERP is ALREADY LOCKED DOWN!</b>\n\nVisitors are currently seeing the <i>503 Service Unavailable</i> maintenance screen.\n\nSend <code>/up</code> to restore.`);
        return;
      }

      try {
        setMaintenanceOn(fromUser);
        console.log(`🚨 LOCKDOWN ACTIVATED by @${fromUser?.username || chatId} at ${new Date().toISOString()}`);

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

        await sendMessage(chatId, msg);
      } catch (err) {
        console.error('Failed to create maintenance flag:', err);
        await sendMessage(chatId, `❌ <b>Failed to activate lockdown:</b>\n<code>${err.message}</code>`);
      }
      break;
    }

    case 'up': {
      if (!isMaintenanceActive()) {
        await sendMessage(chatId, `ℹ️ <b>Aura ERP is ALREADY ONLINE!</b>\n\nNormal access is active.\n\nSend <code>/down</code> to shut down.`);
        return;
      }

      try {
        setMaintenanceOff();
        console.log(`✅ LOCKDOWN DEACTIVATED by @${fromUser?.username || chatId} at ${new Date().toISOString()}`);

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

        await sendMessage(chatId, msg);
      } catch (err) {
        console.error('Failed to remove maintenance flag:', err);
        await sendMessage(chatId, `❌ <b>Failed to deactivate lockdown:</b>\n<code>${err.message}</code>`);
      }
      break;
    }

    case 'status': {
      const active = isMaintenanceActive();
      const stats = getServerStats();

      let flagDetails = '';
      if (active) {
        try {
          const content = JSON.parse(fs.readFileSync(FLAG_PATH, 'utf8'));
          flagDetails = `\n• <b>Locked Since:</b> ${content.lockedAt || 'N/A'}\n• <b>Locked By:</b> ${content.lockedBy || 'Admin'}`;
        } catch (e) {}
      }

      const msg = [
        `📊 <b>Aura ERP System Status</b>`,
        `━━━━━━━━━━━━━━━━━━━━━━━━━`,
        `• <b>Site Status:</b> ${active ? '🔴 LOCKED DOWN (503 Active)' : '🟢 ONLINE (Normal)'}`,
        flagDetails,
        `• <b>Server Memory:</b> ${stats.memory}`,
        `• <b>Server Uptime:</b> ${stats.uptime}`,
        `• <b>Flag Path:</b> <code>${FLAG_PATH}</code>`,
        ``,
        active 
          ? `👉 Send <code>/up</code> to restore site.` 
          : `👉 Send <code>/down</code> to shut down site.`
      ].filter(Boolean).join('\n');

      await sendMessage(chatId, msg);
      break;
    }

    default:
      await sendMessage(chatId, `❓ Unknown command: <code>${command}</code>\nSend <code>/help</code> for available commands.`);
  }
}

// Long Polling Loop
let lastUpdateId = 0;
async function pollUpdates() {
  try {
    const updates = await telegramRequest('getUpdates', {
      offset: lastUpdateId + 1,
      timeout: 30,
      allowed_updates: ['message']
    });

    console.log(" updates :: ", updates);
    

    if (Array.isArray(updates)) {
      for (const update of updates) {
        lastUpdateId = update.update_id;
        if (update.message && update.message.text) {
          await handleMessage(update.message);
        }
      }
    }
  } catch (err) {
    if (err.message && !err.message.includes('timeout')) {
      console.error('Polling error:', err.message);
    }
    // Pause briefly on error before retrying
    await new Promise(r => setTimeout(r, 2000));
  }

  // Continue polling immediately
  setImmediate(pollUpdates);
}

// Start bot
console.log('🚀 Checking Telegram connection...');
telegramRequest('getMe')
  .then(botInfo => {
    console.log(`✅ Connected as Telegram Bot: @${botInfo.username} (${botInfo.first_name})`);
    console.log('📡 Listening for commands (/down, /up, /status)...');
    pollUpdates();
  })
  .catch(err => {
    console.error('❌ Failed to connect to Telegram API:', err.message);
    console.error('Please verify your TELEGRAM_BOT_TOKEN.');
    setTimeout(() => process.exit(1), 5000);
  });

