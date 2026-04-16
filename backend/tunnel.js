// Автоматический туннель через localhost.run
// Запускается через PM2, при падении перезапускается автоматически

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const API_URL_FILE = path.join(__dirname, '..', 'docs', 'app.js');
const FRONTEND_FILE = path.join(__dirname, '..', 'frontend', 'app.js');

function updateApiUrl(newUrl) {
  [API_URL_FILE, FRONTEND_FILE].forEach(file => {
    if (!fs.existsSync(file)) return;
    let content = fs.readFileSync(file, 'utf8');
    content = content.replace(
      /const API_URL = '.*?';/,
      `const API_URL = '${newUrl}';`
    );
    fs.writeFileSync(file, content, 'utf8');
  });
  console.log(`[tunnel] API_URL обновлён: ${newUrl}`);
}

function startTunnel() {
  console.log('[tunnel] Запуск туннеля localhost.run...');

  const ssh = spawn('ssh', [
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    '-R', '80:localhost:3000',
    'nokey@localhost.run'
  ]);

  ssh.stdout.on('data', (data) => {
    const text = data.toString();
    console.log('[tunnel stdout]', text);

    // Парсим URL из строки вида: xxxxx.lhr.life tunneled with tls termination, https://xxxxx.lhr.life
    const match = text.match(/https:\/\/([a-z0-9]+\.lhr\.life)/);
    if (match) {
      const url = `https://${match[1]}`;
      console.log(`[tunnel] ✅ Туннель активен: ${url}`);
      updateApiUrl(url);
    }
  });

  ssh.stderr.on('data', (data) => {
    const text = data.toString();
    // Ищем URL в stderr тоже
    const match = text.match(/https:\/\/([a-z0-9]+\.lhr\.life)/);
    if (match) {
      const url = `https://${match[1]}`;
      console.log(`[tunnel] ✅ Туннель активен: ${url}`);
      updateApiUrl(url);
    }
  });

  ssh.on('close', (code) => {
    console.log(`[tunnel] Соединение закрыто (код ${code}). Перезапуск через 5 сек...`);
    setTimeout(startTunnel, 5000);
  });

  ssh.on('error', (err) => {
    console.error('[tunnel] Ошибка:', err.message);
  });
}

startTunnel();
