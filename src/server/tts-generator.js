const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');
const https = require('https');
const crypto = require('crypto');

// Target Directories
const rootDir = process.cwd();
const dataDir = path.join(rootDir, 'data');
const piperDir = path.join(dataDir, 'piper');
const cacheDir = path.join(dataDir, 'tts-cache');

// Ensure directories exist
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);
if (!fs.existsSync(piperDir)) fs.mkdirSync(piperDir);
if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir);

// State info
let statusCallback = null;
let isInitializing = false;
let isReady = false;
let lastStatus = { status: 'idle', progress: 0, message: 'Not started.' };

// Config URLs
const BINARY_URLS = {
  win32: 'https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip',
  linux: 'https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_x86_64.tar.gz'
};

const MODELS = {
  id: {
    onnx: 'https://huggingface.co/rhasspy/piper-voices/resolve/main/id/id_ID/news_tts/medium/id_ID-news_tts-medium.onnx',
    json: 'https://huggingface.co/rhasspy/piper-voices/resolve/main/id/id_ID/news_tts/medium/id_ID-news_tts-medium.onnx.json',
    file: 'id_ID-news_tts-medium.onnx'
  },
  en: {
    onnx: 'https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx',
    json: 'https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx.json',
    file: 'en_US-lessac-medium.onnx'
  },
  zh: {
    onnx: 'https://huggingface.co/rhasspy/piper-voices/resolve/main/zh/zh_CN/huayan/medium/zh_CN-huayan-medium.onnx',
    json: 'https://huggingface.co/rhasspy/piper-voices/resolve/main/zh/zh_CN/huayan/medium/zh_CN-huayan-medium.onnx.json',
    file: 'zh_CN-huayan-medium.onnx'
  }
};

function getBinaryPath() {
  if (process.platform === 'win32') {
    return path.join(piperDir, 'piper', 'piper.exe');
  } else {
    return path.join(piperDir, 'piper', 'piper');
  }
}

// Set status and notify
function setStatus(status, progress = 0, message = '') {
  console.log(`[TTS Engine] ${status} - ${progress}% - ${message}`);
  lastStatus = { status, progress, message };
  if (statusCallback) {
    statusCallback(lastStatus);
  }
}

// Helper to download file
function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    // Delete target file if it already exists before starting download to prevent conflicts
    if (fs.existsSync(dest)) {
      try { fs.unlinkSync(dest); } catch (_) {}
    }

    const file = fs.createWriteStream(dest);
    
    const cleanupAndReject = (err) => {
      file.end(() => {
        try { fs.unlinkSync(dest); } catch (_) {}
        reject(err);
      });
    };

    const request = https.get(url, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        // Handle redirect (resolving relative paths against the original url)
        let redirectUrl;
        try {
          redirectUrl = new URL(response.headers.location, url).toString();
        } catch (e) {
          redirectUrl = response.headers.location;
        }
        file.end(() => {
          downloadFile(redirectUrl, dest).then(resolve).catch(reject);
        });
        return;
      }
      
      if (response.statusCode !== 200) {
        cleanupAndReject(new Error(`Failed to download: Status Code ${response.statusCode}`));
        return;
      }

      const totalSize = parseInt(response.headers['content-length'], 10) || 0;
      let downloadedSize = 0;

      response.on('data', (chunk) => {
        downloadedSize += chunk.length;
        if (totalSize > 0) {
          const percent = Math.round((downloadedSize / totalSize) * 100);
          setStatus('downloading', percent, `Downloading ${path.basename(dest)}...`);
        }
      });

      response.pipe(file);

      file.on('finish', () => {
        file.close();
        resolve();
      });
    });

    request.on('error', (err) => {
      cleanupAndReject(err);
    });
  });
}

// Helper to extract zip/tar.gz
function extractArchive(archivePath, destDir) {
  return new Promise((resolve, reject) => {
    if (process.platform === 'win32') {
      // Windows: use PowerShell
      const cmd = `powershell -Command "Expand-Archive -Path '${archivePath}' -DestinationPath '${destDir}' -Force"`;
      exec(cmd, (err) => {
        if (err) reject(err);
        else resolve();
      });
    } else {
      // Linux: use tar
      const cmd = `tar -xzf "${archivePath}" -C "${destDir}"`;
      exec(cmd, (err) => {
        if (err) reject(err);
        else resolve();
      });
    }
  });
}

function fileExistsAndNotEmpty(filePath) {
  try {
    return fs.existsSync(filePath) && fs.statSync(filePath).size > 0;
  } catch (_) {
    return false;
  }
}

// Initialize TTS Engine (Download binaries and models if missing)
async function initTtsEngine(callback) {
  if (callback) statusCallback = callback;
  if (isReady) {
    setStatus('ready', 100, 'TTS Engine is ready.');
    return true;
  }
  if (isInitializing) return false;
  isInitializing = true;

  try {
    const binaryPath = getBinaryPath();
    const binaryExists = fileExistsAndNotEmpty(binaryPath);

    // 1. Download Piper Binary
    if (!binaryExists) {
      const platform = process.platform === 'win32' ? 'win32' : 'linux';
      const url = BINARY_URLS[platform];
      if (!url) {
        throw new Error(`Unsupported platform: ${process.platform}`);
      }

      const archiveName = platform === 'win32' ? 'piper.zip' : 'piper.tar.gz';
      const archivePath = path.join(piperDir, archiveName);

      setStatus('downloading_binary', 0, 'Downloading Piper local binary...');
      await downloadFile(url, archivePath);

      setStatus('extracting_binary', 50, 'Extracting Piper binary...');
      await extractArchive(archivePath, piperDir);
      
      // Clean up archive
      try { fs.unlinkSync(archivePath); } catch (_) {}

      // Make executable on linux
      if (process.platform !== 'win32') {
        fs.chmodSync(binaryPath, '755');
      }
    }

    // 2. Download Models (re-download if empty/corrupted)
    for (const lang of Object.keys(MODELS)) {
      const m = MODELS[lang];
      const modelPath = path.join(piperDir, m.file);
      const configPath = path.join(piperDir, m.file + '.json');

      if (!fileExistsAndNotEmpty(modelPath)) {
        setStatus(`downloading_model_${lang}`, 0, `Downloading ${lang.toUpperCase()} voice model...`);
        await downloadFile(m.onnx, modelPath);
      }
      if (!fileExistsAndNotEmpty(configPath)) {
        setStatus(`downloading_config_${lang}`, 0, `Downloading ${lang.toUpperCase()} voice config...`);
        await downloadFile(m.json, configPath);
      }
    }

    isReady = true;
    isInitializing = false;
    setStatus('ready', 100, 'TTS Engine initialized successfully.');

    // 3. Pre-generate vocab in background
    setTimeout(preGenerateVocab, 1000);

    return true;
  } catch (err) {
    isInitializing = false;
    setStatus('error', 0, `Initialization failed: ${err.message}`);
    return false;
  }
}

// Generate WAV file using Piper
function generateWav(text, lang, outputPath) {
  return new Promise((resolve, reject) => {
    if (!isReady) {
      reject(new Error('TTS Engine is not initialized.'));
      return;
    }

    const binaryPath = getBinaryPath();
    const modelInfo = MODELS[lang];
    if (!modelInfo) {
      reject(new Error(`Unsupported language code: ${lang}`));
      return;
    }

    const modelPath = path.join(piperDir, modelInfo.file);
    const args = ['--model', modelPath, '--output_file', outputPath];

    const child = spawn(binaryPath, args, { cwd: piperDir });

    child.stdin.write(text + '\n');
    child.stdin.end();

    child.on('close', (code) => {
      if (code === 0 && fs.existsSync(outputPath)) {
        resolve(outputPath);
      } else {
        let errorMsg = `Piper exited with code ${code}`;
        if (code === 3221225781 || code === -1073741515) {
          errorMsg = `Piper crashed (exit code ${code}). PC Anda belum terinstal Microsoft Visual C++ Redistributable. Silakan unduh dan instal vc_redist.x64 dari situs resmi Microsoft.`;
        } else if (code === 3221225595 || code === -1073741701) {
          errorMsg = `Piper crashed (exit code ${code}). Kemungkinan sistem operasi Windows Anda adalah 32-bit (x86), sedangkan Piper membutuhkan Windows 64-bit (x64).`;
        }
        reject(new Error(errorMsg));
      }
    });

    child.on('error', (err) => {
      reject(err);
    });
  });
}

// Hash helper for custom phrases
function getPhraseFilename(text, lang) {
  const hash = crypto.createHash('md5').update(text.trim().toLowerCase()).digest('hex');
  return `${lang}_phrase_${hash}.wav`;
}

// Adaptively generate custom phrase if missing
async function generatePhraseIfNeeded(text, lang) {
  if (!text || !text.trim()) return null;
  
  const filename = getPhraseFilename(text, lang);
  const targetPath = path.join(cacheDir, filename);

  if (fileExistsAndNotEmpty(targetPath)) {
    return filename; // Already cached
  }

  try {
    await generateWav(text, lang, targetPath);
    console.log(`[TTS Engine] Generated custom phrase audio: ${filename}`);
    return filename;
  } catch (err) {
    console.error(`[TTS Engine] Failed to generate phrase audio for "${text}":`, err.message);
    return null;
  }
}

// Generate all basic numbers and letters
async function preGenerateVocab() {
  console.log('[TTS Engine] Starting background pre-generation of standard audio clips...');
  setStatus('generating_vocab', 10, 'Generating basic voice clips (numbers & letters)...');

  try {
    // 1. Letters A-Z
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
    
    // Indonesian letters
    const idLetters = {
      A: 'a', B: 'be', C: 'se', D: 'de', E: 'e', F: 'ef', G: 'ge', H: 'ha', I: 'i',
      J: 'je', K: 'ka', L: 'el', M: 'em', N: 'en', O: 'o', P: 'pe', Q: 'ki', R: 'er',
      S: 'es', T: 'te', U: 'u', V: 'fe', W: 'we', X: 'eks', Y: 'ye', Z: 'zet'
    };

    // Chinese letters
    const zhLetters = {
      A: 'A', B: 'B', C: 'C', D: 'D', E: 'E', F: 'F', G: 'G', H: 'H', I: 'I',
      J: 'J', K: 'K', L: 'L', M: 'M', N: 'N', O: 'O', P: 'P', Q: 'Q', R: 'R',
      S: 'S', T: 'T', U: 'U', V: 'V', W: 'W', X: 'X', Y: 'Y', Z: 'Z'
    };

    for (const char of alphabet) {
      // ID Letter
      const idPath = path.join(cacheDir, `id_letter_${char}.wav`);
      if (!fileExistsAndNotEmpty(idPath)) {
        await generateWav(`Antrian ${idLetters[char]}`, 'id', idPath);
      }
      
      // EN Letter
      const enPath = path.join(cacheDir, `en_letter_${char}.wav`);
      if (!fileExistsAndNotEmpty(enPath)) {
        await generateWav(`Queue ${char}`, 'en', enPath);
      }
      
      // ZH Letter
      const zhPath = path.join(cacheDir, `zh_letter_${char}.wav`);
      if (!fileExistsAndNotEmpty(zhPath)) {
        await generateWav(`排队号码 ${zhLetters[char]}`, 'zh', zhPath);
      }
    }

    // 2. Basic Indonesian Numbers
    const idNumbers = {
      '0': 'nol', '1': 'satu', '2': 'dua', '3': 'tiga', '4': 'empat', '5': 'lima',
      '6': 'enam', '7': 'tujuh', '8': 'delapan', '9': 'sembilan', '10': 'sepuluh',
      '11': 'sebelas', '12': 'dua belas', '13': 'tiga belas', '14': 'empat belas',
      '15': 'lima belas', '16': 'enam belas', '17': 'tujuh belas', '18': 'delapan belas',
      '19': 'sembilan belas', '100': 'seratus', 'puluh': 'puluh', 'ratus': 'ratus', 'belas': 'belas'
    };

    for (const key of Object.keys(idNumbers)) {
      const targetPath = path.join(cacheDir, `id_${key}.wav`);
      if (!fileExistsAndNotEmpty(targetPath)) {
        await generateWav(idNumbers[key], 'id', targetPath);
      }
    }

    // 3. Basic English Numbers
    const enNumbers = {
      '0': 'zero', '1': 'one', '2': 'two', '3': 'three', '4': 'four', '5': 'five',
      '6': 'six', '7': 'seven', '8': 'eight', '9': 'nine', '10': 'ten',
      '11': 'eleven', '12': 'twelve', '13': 'thirteen', '14': 'fourteen', '15': 'fifteen',
      '16': 'sixteen', '17': 'seventeen', '18': 'eighteen', '19': 'nineteen',
      '20': 'twenty', '30': 'thirty', '40': 'forty', '50': 'fifty',
      '60': 'sixty', '70': 'seventy', '80': 'eighty', '90': 'ninety',
      'hundred': 'hundred'
    };

    for (const key of Object.keys(enNumbers)) {
      const targetPath = path.join(cacheDir, `en_${key}.wav`);
      if (!fileExistsAndNotEmpty(targetPath)) {
        await generateWav(enNumbers[key], 'en', targetPath);
      }
    }

    // 4. Basic Chinese Numbers
    const zhNumbers = {
      '0': '零', '1': '一', '2': '二', '3': '三', '4': '四', '5': '五',
      '6': '六', '7': '七', '8': '八', '9': '九', '10': '十', '100': '百',
      'shi': '十', 'bai': '百'
    };

    for (const key of Object.keys(zhNumbers)) {
      const targetPath = path.join(cacheDir, `zh_${key}.wav`);
      if (!fileExistsAndNotEmpty(targetPath)) {
        await generateWav(zhNumbers[key], 'zh', targetPath);
      }
    }

    // 5. Static structural words
    const staticWords = [
      { key: 'id_nomor_antrian', text: 'Nomor antrian', lang: 'id' },
      { key: 'id_silakan_menuju', text: 'Silakan menuju', lang: 'id' },
      { key: 'id_loket', text: 'Loket', lang: 'id' },
      { key: 'en_queue_number', text: 'Queue number', lang: 'en' },
      { key: 'en_please_proceed_to', text: 'Please proceed to', lang: 'en' },
      { key: 'en_counter', text: 'counter', lang: 'en' },
      { key: 'zh_queue_number', text: '排队号码', lang: 'zh' },
      { key: 'zh_please_proceed_to', text: '请前往', lang: 'zh' },
      { key: 'zh_counter', text: '柜台', lang: 'zh' }
    ];

    for (const w of staticWords) {
      const targetPath = path.join(cacheDir, `${w.key}.wav`);
      if (!fileExistsAndNotEmpty(targetPath)) {
        await generateWav(w.text, w.lang, targetPath);
      }
    }

    setStatus('ready', 100, 'TTS audio vocabulary generation complete.');
  } catch (err) {
    console.error('[TTS Engine] Failed pre-generating standard vocabulary:', err.message);
    setStatus('error', 0, `Generasi audio gagal: ${err.message}. Periksa dependensi sistem.`);
  }
}

module.exports = {
  initTtsEngine,
  generatePhraseIfNeeded,
  getPhraseFilename,
  isReady: () => isReady,
  isInitializing: () => isInitializing,
  getLastStatus: () => lastStatus,
  cacheDir
};
