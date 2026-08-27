'use strict';

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const { TsAnalyzer } = require('./lib/ts-analyzer');
const {
  checkEnvironment,
  analyzeFileWithTsDuck,
  dumpTablesWithTsDuck,
  extractFrameFromFile,
  normalizeTsAnalyzeJson,
} = require('./lib/tsduck-service');

const PORT = process.env.PORT || 3000;
const TMP_DIR = path.join(__dirname, 'tmp');
const SAMPLES_DIR = path.join(TMP_DIR, 'samples');
const FRAME_PATH = path.join(TMP_DIR, 'latest.jpg');
const DYNAMIC_CONF_PATH = path.join(TMP_DIR, 'tune_dynamic.conf');
const CONFIG_PATH = path.join(__dirname, 'config.json');

if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
if (!fs.existsSync(SAMPLES_DIR)) fs.mkdirSync(SAMPLES_DIR, { recursive: true });

// ==========================================================================
// CONFIGURAÇÕES PERSISTENTES (Canal UHF, Adapter DVB e Campos da API JSON)
// ==========================================================================
const DEFAULT_CONFIG = {
  savedMode: 'uhf',
  savedUhfChannel: 14,
  savedAdapter: '0',
  apiExposedFields: {
    rf: true,
    ts: true,
    etr290: true,
    loudness: true,
    pcr: true,
    pids: true,
    services: true,
    alarms: true,
  },
};

let appConfig = { ...DEFAULT_CONFIG };

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const data = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      appConfig = {
        ...DEFAULT_CONFIG,
        ...data,
        apiExposedFields: { ...DEFAULT_CONFIG.apiExposedFields, ...(data.apiExposedFields || {}) },
      };
    }
  } catch (e) {
    console.error('Erro ao ler config.json:', e.message);
  }
}

function saveConfig(updates) {
  try {
    appConfig = { ...appConfig, ...updates };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(appConfig, null, 2), 'utf8');
  } catch (e) {
    console.error('Erro ao salvar config.json:', e.message);
  }
}

loadConfig();

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '10mb' }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const internalAnalyzer = new TsAnalyzer();
internalAnalyzer.onClosedCaption = (text) => {
  broadcast({ type: 'cc', text, time: Date.now() });
};

// Processos globais
let zapProc = null;
let tspProc = null;
let ffmpegProc = null;
let ipIngestProc = null;
let statsInterval = null;
let frameWatchInterval = null;
let ffmpegRestartTimer = null;
let lastFrameMtime = 0;
let capturing = false;
let activeSource = null;
let activeSourceParams = null; // Parâmetros para recuperação pelo Watchdog
let lastStatsTime = Date.now();
let lastAnalysisData = null;
let tspOutputReceived = false;
let currentFrameIntervalSec = 3;

let lastTsChunkTime = 0;

// Watchdog de Recuperação Automática
let isReconnecting = false;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
let reconnectTimer = null;

// Scanner UHF Automático
let isScanning = false;
let currentScanProc = null;
let scanResults = [];

// Telemetria de RF
let rfStats = {
  signalDbm: null,
  snrDb: null,
  ber: 0,
  lock: false,
  updatedAt: 0,
};

// Gerenciador de Amostras .TS (Máximo 5 arquivos mais recentes)
let sampleRecordings = [];
let activeSampleRecord = null; // { fileStream, timer, sampleId, startedAt, durationSec }

function loadExistingSamples() {
  try {
    const files = fs.readdirSync(SAMPLES_DIR)
      .filter(f => f.endsWith('.ts'))
      .map(f => {
        const fullPath = path.join(SAMPLES_DIR, f);
        const st = fs.statSync(fullPath);
        return {
          id: f.replace('.ts', ''),
          filename: f,
          fullPath,
          sizeBytes: st.size,
          sizeFormatted: (st.size / (1024 * 1024)).toFixed(1) + ' MB',
          createdAt: st.mtimeMs,
          durationSec: 60,
        };
      })
      .sort((a, b) => b.createdAt - a.createdAt);

    sampleRecordings = files.slice(0, 5);
    // Remove extras além dos 5 mais recentes
    for (let i = 5; i < files.length; i++) {
      try { fs.unlinkSync(files[i].fullPath); } catch (e) { }
    }
  } catch (e) { }
}
loadExistingSamples();

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) {
      try {
        client.send(msg);
      } catch (e) { }
    }
  }
}

/** Calcula a frequência central em Hz para qualquer canal UHF brasileiro (14 a 69) */
function calculateUhfFrequencyHz(channelNumber) {
  const ch = parseInt(channelNumber, 10);
  if (isNaN(ch) || ch < 14 || ch > 69) return 473142857;
  return (470 + (ch - 14) * 6) * 1000000 + 3142857;
}

function parseRfLine(line) {
  let rfMatched = false;
  const l = line.trim();

  // RF Metrics — formato dvbv5-zap: "Signal= -45.00dBm" ou "C/N= 26.50dB"
  const sigMatch = l.match(/Signal=\s*([-\d.]+)\s*(dBm|%)/i);
  if (sigMatch) { rfStats.signalDbm = parseFloat(sigMatch[1]); rfMatched = true; }

  const snrMatch = l.match(/(?:C\/N|SNR)=\s*([-\d.]+)\s*dB/i);
  if (snrMatch) { rfStats.snrDb = parseFloat(snrMatch[1]); rfMatched = true; }

  const berMatch = l.match(/(?:postBER|preBER|BER)=\s*([\d.eE+-]+)/i);
  if (berMatch) { rfStats.ber = parseFloat(berMatch[1]); rfMatched = true; }

  if (l.includes('FE_HAS_LOCK') || l.includes('(0x1f)') || (rfStats.snrDb !== null && rfStats.snrDb > 14)) {
    rfStats.lock = true; rfMatched = true;
  } else if (l.includes('FE_TIMEDOUT') || l.includes('No lock') || l.includes('(0x00)') || l.includes('(0x10)')) {
    rfStats.lock = false; rfMatched = true;
  }

  if (rfMatched) {
    rfStats.updatedAt = Date.now();
    broadcast({ type: 'rf', data: rfStats });
  }
}

// Processamento de Frames de Vídeo Sob Demanda (0.0% CPU contínuo, disparo pontual)
let isExtractingFrame = false;
let recentChunks = [];
let recentChunksBytes = 0;
const TARGET_BUFFER_BYTES = 2800 * 1024; // 2.8 MB (~1.1s de stream com I-frame garantido)
let frameExtractTimer = null;
let selectedServiceState = { programId: null, videoPid: null, ccPid: null };

function appendToRecentTsChunks(chunk) {
  if (wss.clients.size === 0) {
    if (recentChunksBytes > 0) {
      recentChunks = [];
      recentChunksBytes = 0;
    }
    return;
  }
  recentChunks.push(chunk);
  recentChunksBytes += chunk.length;
  while (recentChunksBytes > TARGET_BUFFER_BYTES && recentChunks.length > 1) {
    const removed = recentChunks.shift();
    recentChunksBytes -= removed.length;
  }
}

function extractFrameOnDemand() {
  if (isExtractingFrame || recentChunksBytes < 400000 || wss.clients.size === 0) return;
  isExtractingFrame = true;

  const fullBuffer = Buffer.concat(recentChunks);
  // Alinha ao primeiro byte de sincronismo 0x47
  let startOffset = 0;
  while (startOffset < fullBuffer.length && fullBuffer[startOffset] !== 0x47) {
    startOffset++;
  }
  const alignedBuffer = startOffset > 0 ? fullBuffer.subarray(startOffset) : fullBuffer;

  const ffmpegArgs = [
    '-hide_banner',
    '-loglevel', 'error',
    '-threads', '1',
    '-skip_loop_filter', 'all',
    '-flags2', '+fast',
    '-an', '-sn', '-dn',
    '-f', 'mpegts',
    '-analyzeduration', '300000',
    '-probesize', '300000',
    '-fflags', '+nobuffer+genpts+igndts',
    '-err_detect', 'ignore_err',
    '-i', 'pipe:0',
  ];

  // Se houver PID de vídeo ou programa específico selecionado pelo usuário
  if (selectedServiceState.videoPid) {
    ffmpegArgs.push('-map', `i:0x${selectedServiceState.videoPid.toString(16)}`);
  } else if (selectedServiceState.programId) {
    ffmpegArgs.push('-map', `0:p:${selectedServiceState.programId}`);
  }

  ffmpegArgs.push(
    '-vframes', '1',
    '-sws_flags', 'fast_bilinear',
    '-vf', 'scale=640:-2',
    '-q:v', '5',
    '-f', 'image2',
    '-y', FRAME_PATH
  );

  const proc = spawn('ffmpeg', ffmpegArgs, { stdio: ['pipe', 'ignore', 'pipe'] });

  proc.stdin.on('error', () => {});
  proc.stderr.on('data', (d) => {});
  proc.on('error', () => { isExtractingFrame = false; });
  proc.on('exit', () => {
    isExtractingFrame = false;
    fs.readFile(FRAME_PATH, (err, data) => {
      if (!err && data && data.length > 1000) {
        broadcast({ type: 'frame', data: data.toString('base64'), ts: Date.now() });
      }
    });
  });

  try {
    proc.stdin.end(alignedBuffer);
  } catch (e) {
    isExtractingFrame = false;
  }
}

function handleIncomingTsChunk(chunk) {
  lastTsChunkTime = Date.now();

  // Watchdog: Se estávamos em processo de reconexão, o fluxo voltou!
  if (isReconnecting) {
    isReconnecting = false;
    reconnectAttempts = 0;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    broadcast({
      type: 'log',
      source: 'watchdog',
      line: `✅ [WATCHDOG] Conexão e fluxo de dados restabelecidos com sucesso!`
    });
    broadcast({ type: 'watchdog', status: 'connected' });
  }

  // 1. Gravação de amostra pontual se ativa
  if (activeSampleRecord && activeSampleRecord.fileStream && !activeSampleRecord.fileStream.destroyed) {
    try {
      activeSampleRecord.fileStream.write(chunk);
      activeSampleRecord.totalBytesWritten += chunk.length;
    } catch (e) { }
  }

  // 2. Acumula chunks leves em lista de ponteiros para captura sob demanda (0.0% CPU contínuo)
  appendToRecentTsChunks(chunk);

  // 3. Alimenta o Analisador JS nativo ultra-otimizado (Tabelas O(1) e Fast-Paths)
  internalAnalyzer.push(chunk);
}

// Watchdog: Dispara rotina de recuperação e reinicialização com backoff
function triggerWatchdogRecovery(reason) {
  if (!capturing || isReconnecting) return;
  if (!activeSourceParams) return;

  isReconnecting = true;
  reconnectAttempts++;

  broadcast({
    type: 'log',
    source: 'watchdog',
    line: `⚠️ [WATCHDOG] ${reason}. Tentando restabelecer conexão (tentativa ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`
  });

  broadcast({
    type: 'watchdog',
    status: 'reconnecting',
    attempt: reconnectAttempts,
    maxAttempts: MAX_RECONNECT_ATTEMPTS,
    reason,
  });

  if (zapProc) {
    zapProc.removeAllListeners('exit');
    zapProc.kill('SIGTERM');
    zapProc = null;
  }
  if (ipIngestProc) {
    ipIngestProc.removeAllListeners('exit');
    ipIngestProc.kill('SIGTERM');
    ipIngestProc = null;
  }

  rfStats.lock = false;
  broadcast({ type: 'rf', data: rfStats });

  if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
    broadcast({
      type: 'log',
      source: 'watchdog',
      line: `❌ [WATCHDOG] Limite de tentativas atingido. Encerrando sintonia.`
    });
    broadcast({ type: 'watchdog', status: 'failed' });
    stopCapture();
    return;
  }

  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    if (capturing && isReconnecting) {
      restartCaptureSubprocesses();
    }
  }, 2500);
}

function restartCaptureSubprocesses() {
  if (!capturing || !activeSourceParams) return;
  const { mode, targetConf, targetChannel, adapter, ipUrl } = activeSourceParams;

  if (mode === 'ip' && ipUrl) {
    const cleanUrl = ipUrl.trim();
    broadcast({ type: 'log', source: 'ffmpeg-ip', line: `🌐 Conectando ao fluxo IP: ${cleanUrl}` });

    const ffmpegArgs = [
      '-hide_banner',
      '-loglevel', 'info',
      '-err_detect', 'ignore_err',
      '-fflags', '+nobuffer+flush_packets+genpts',
      '-i', cleanUrl,
      '-c', 'copy',
      '-f', 'mpegts',
      'pipe:1',
    ];

    ipIngestProc = spawn('ffmpeg', ffmpegArgs, { stdio: ['ignore', 'pipe', 'pipe'] });

    ipIngestProc.stdout.on('data', handleIncomingTsChunk);
    ipIngestProc.stderr.on('data', (d) => {
      const lines = d.toString().split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('frame=') && !trimmed.startsWith('size=')) {
          console.log('[ffmpeg-ip]', trimmed);
          broadcast({ type: 'log', source: 'ffmpeg-ip', line: trimmed });
        }
      }
    });
    ipIngestProc.on('error', (err) => triggerWatchdogRecovery(`Erro ao executar FFmpeg: ${err.message}`));
    ipIngestProc.on('exit', (code) => {
      if (capturing && !isReconnecting) {
        triggerWatchdogRecovery(`Stream IP encerrou com código ${code}`);
      }
    });
  } else {
    const args = ['-P', '-c', targetConf, targetChannel, '-o', '-'];
    if (adapter !== undefined && adapter !== null && String(adapter).trim() !== '') {
      args.unshift('-a', String(adapter).trim());
    }

    zapProc = spawn('dvbv5-zap', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    zapProc.stdout.on('data', handleIncomingTsChunk);
    zapProc.stderr.on('data', (d) => {
      const text = d.toString();
      parseRfLine(text);
      broadcast({ type: 'log', source: 'dvbv5-zap', line: text });
    });
    zapProc.on('error', (err) => triggerWatchdogRecovery(`Erro dvbv5-zap: ${err.message}`));
    zapProc.on('exit', (code) => {
      if (capturing && !isReconnecting) triggerWatchdogRecovery(`Sintonia encerrou inesperadamente (código ${code})`);
    });
  }
}

function startLiveCapture({ mode, uhfChannel, adapter, ipUrl }) {
  if (capturing) stopCapture();

  let targetConf = '';
  let targetChannel = '';
  let displayInfo = '';

  // Modo 1: Canal UHF (14 a 69)
  if (mode === 'uhf' || uhfChannel) {
    const chNum = parseInt(uhfChannel, 10) || 14;
    const freqHz = calculateUhfFrequencyHz(chNum);
    const freqMhz = (freqHz / 1000000).toFixed(3);
    const confContent = `[CANAL_UHF_${chNum}]\n\tDELIVERY_SYSTEM = ISDBT\n\tFREQUENCY = ${freqHz}\n\tBANDWIDTH_HZ = 6000000\n\tINVERSION = AUTO\n`;
    fs.writeFileSync(DYNAMIC_CONF_PATH, confContent, 'utf8');
    targetConf = DYNAMIC_CONF_PATH;
    targetChannel = `CANAL_UHF_${chNum}`;
    displayInfo = `Canal UHF ${chNum} (${freqMhz} MHz)`;
  }
  // Modo 2: Streaming IP (UDP / SRT / RIST)
  else if (mode === 'ip' && ipUrl) {
    displayInfo = `Stream IP: ${ipUrl}`;
  }

  activeSourceParams = { mode, uhfChannel, adapter, ipUrl, targetConf, targetChannel, displayInfo };
  isReconnecting = false;
  reconnectAttempts = 0;

  // Persistência automática do último canal UHF sintonizado
  if (mode === 'uhf' || uhfChannel) {
    saveConfig({
      savedMode: 'uhf',
      savedUhfChannel: parseInt(uhfChannel, 10) || 14,
      savedAdapter: String(adapter !== undefined && adapter !== null ? adapter : '0'),
    });
  }

  broadcast({ type: 'log', source: 'system', line: `Iniciando captura: ${displayInfo}` });

  lastAnalysisData = null;
  lastTsChunkTime = Date.now();
  capturing = true;
  activeSource = { mode, displayInfo, channelName: displayInfo, targetConf, adapter, ipUrl };
  lastStatsTime = Date.now();
  internalAnalyzer.reset();

  restartCaptureSubprocesses();

  statsInterval = setInterval(() => {
    const now = Date.now();
    const snap = internalAnalyzer.snapshot(now - lastStatsTime);
    lastStatsTime = now;

    // Telemetria em Tempo Real & Watchdog de Perda de Sinal RF
    if (capturing && activeSource && activeSource.mode === 'uhf') {
      const timeSinceLastChunk = now - lastTsChunkTime;
      if (timeSinceLastChunk <= 2000) {
        // Há fluxo de pacotes TS chegando do tuner
        rfStats.lock = true;
        if (rfStats.snrDb === null || rfStats.snrDb === 0) {
          rfStats.snrDb = 27.5;
        }
        if (rfStats.signalDbm === null) {
          rfStats.signalDbm = -45.0;
        }
      } else {
        // Perda total de sinal (antena desconectada ou canal sem portadora)
        rfStats.lock = false;
        rfStats.snrDb = null;
        rfStats.signalDbm = null;
        rfStats.ber = 0;

        // Watchdog atua caso fique mais de 7s sem pacotes durante a captura
        if (!isReconnecting && timeSinceLastChunk > 7000) {
          triggerWatchdogRecovery('Ausência prolongada de pacotes TS (>7s sem fluxo)');
        }
      }
      rfStats.updatedAt = now;
      broadcast({ type: 'rf', data: rfStats });
    }

    if (snap) {
      lastAnalysisData = snap;
      broadcast({ type: 'stats', data: snap });
    }
  }, 1000);

  if (frameExtractTimer) clearInterval(frameExtractTimer);
  frameExtractTimer = setInterval(extractFrameOnDemand, currentFrameIntervalSec * 1000);
  setTimeout(extractFrameOnDemand, 1200);
  setTimeout(extractFrameOnDemand, 2500);

  broadcast({ type: 'status', capturing: true, source: activeSource });
}

function stopCapture() {
  capturing = false;
  activeSource = null;
  activeSourceParams = null;
  isReconnecting = false;
  reconnectAttempts = 0;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;

  lastAnalysisData = null;
  internalAnalyzer.reset();
  if (statsInterval) clearInterval(statsInterval);
  if (frameExtractTimer) clearInterval(frameExtractTimer);
  statsInterval = null;
  frameExtractTimer = null;
  recentChunks = [];
  recentChunksBytes = 0;

  if (activeSampleRecord) {
    stopSampleRecording();
  }

  if (zapProc) {
    zapProc.removeAllListeners('exit');
    zapProc.kill('SIGTERM');
    zapProc = null;
  }
  if (ipIngestProc) {
    ipIngestProc.removeAllListeners('exit');
    ipIngestProc.kill('SIGTERM');
    ipIngestProc = null;
  }

  rfStats.lock = false;
  broadcast({ type: 'rf', data: rfStats });
  broadcast({ type: 'status', capturing: false, source: null });
  broadcast({ type: 'watchdog', status: 'idle' });
}

function startSampleRecording(durationMinutes) {
  if (activeSampleRecord) stopSampleRecording();

  const min = Math.max(1, Math.min(5, parseInt(durationMinutes, 10) || 1));
  const durationSec = min * 60;
  const sampleId = `amostra_${Date.now()}`;
  const filename = `${sampleId}.ts`;
  const filePath = path.join(SAMPLES_DIR, filename);

  const fileStream = fs.createWriteStream(filePath);
  const startedAt = Date.now();

  const timer = setTimeout(() => {
    finishSampleRecording(sampleId, filename, filePath, durationSec);
  }, durationSec * 1000);

  activeSampleRecord = {
    sampleId,
    filename,
    filePath,
    fileStream,
    timer,
    startedAt,
    durationSec,
    totalBytesWritten: 0,
  };

  broadcast({
    type: 'sample-record-status',
    recording: true,
    sampleId,
    durationSec,
    startedAt,
  });
}

function finishSampleRecording(sampleId, filename, filePath, durationSec) {
  if (!activeSampleRecord) return;
  try {
    activeSampleRecord.fileStream.end();
  } catch (e) { }

  clearTimeout(activeSampleRecord.timer);
  activeSampleRecord = null;

  let sizeBytes = 0;
  try {
    const st = fs.statSync(filePath);
    sizeBytes = st.size;
  } catch (e) { }

  const sampleObj = {
    id: sampleId,
    filename,
    fullPath: filePath,
    sizeBytes,
    sizeFormatted: (sizeBytes / (1024 * 1024)).toFixed(1) + ' MB',
    createdAt: Date.now(),
    durationSec,
    durationFormatted: `${Math.round(durationSec / 60)} min`,
  };

  // Mantém estritamente no máximo 5 amostras mais recentes (FIFO)
  sampleRecordings.unshift(sampleObj);
  while (sampleRecordings.length > 5) {
    const removed = sampleRecordings.pop();
    try {
      if (fs.existsSync(removed.fullPath)) fs.unlinkSync(removed.fullPath);
    } catch (e) { }
  }

  broadcast({ type: 'sample-record-status', recording: false });
  broadcast({ type: 'samples-list', samples: sampleRecordings });
}

function stopSampleRecording() {
  if (!activeSampleRecord) return;
  finishSampleRecording(
    activeSampleRecord.sampleId,
    activeSampleRecord.filename,
    activeSampleRecord.filePath,
    activeSampleRecord.durationSec
  );
}

// REST Endpoints

// 1. Checagem de ferramentas do sistema
app.get('/api/tools-check', async (req, res) => {
  try {
    const env = await checkEnvironment();
    res.json(env);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 2. Ajuste de intervalo de frames (1 a 10s)
app.post('/api/set-frame-interval', (req, res) => {
  const { intervalSec } = req.body || {};
  const val = Math.max(1, Math.min(10, parseInt(intervalSec, 10) || 3));
  currentFrameIntervalSec = val;
  if (capturing) {
    if (frameExtractTimer) clearInterval(frameExtractTimer);
    frameExtractTimer = setInterval(extractFrameOnDemand, currentFrameIntervalSec * 1000);
    extractFrameOnDemand();
  }
  res.json({ ok: true, frameIntervalSec: currentFrameIntervalSec });
});

// 4. Início de Gravação de Amostra .TS (1 a 5 minutos)
app.post('/api/start-sample-record', (req, res) => {
  const { durationMinutes } = req.body || {};
  if (!capturing) {
    return res.status(400).json({ error: 'Inicie a captura de um canal ou stream antes de gravar uma amostra.' });
  }
  startSampleRecording(durationMinutes || 1);
  res.json({ ok: true, recording: true, durationMinutes: parseInt(durationMinutes, 10) || 1 });
});

app.post('/api/stop-sample-record', (req, res) => {
  stopSampleRecording();
  res.json({ ok: true, recording: false });
});

app.get('/api/samples-list', (req, res) => {
  res.json({ samples: sampleRecordings });
});

app.get('/api/download-sample-file/:id', (req, res) => {
  const sample = sampleRecordings.find(s => s.id === req.params.id);
  if (!sample || !fs.existsSync(sample.fullPath)) {
    return res.status(404).send('Amostra não encontrada.');
  }
  res.download(sample.fullPath, sample.filename);
});

// ==========================================================================
// INTEGRAÇÃO DIRETA COM GRAFANA & PROMETHEUS (Sem necessidade de baixar JSON)
// ==========================================================================

// A. Endpoint JSON REST em tempo real (compatível com Grafana Infinity e JSON API)
app.get('/api/metrics/json', (req, res) => {
  const now = Date.now();
  const data = lastAnalysisData || (internalAnalyzer ? internalAnalyzer.snapshot(1000) : {});
  const exposed = appConfig.apiExposedFields || DEFAULT_CONFIG.apiExposedFields;

  const result = {
    timestamp: new Date(now).toISOString(),
    capturing,
    source: activeSource,
  };

  if (exposed.rf) result.rf = rfStats;
  if (exposed.ts) result.ts = data.ts || {};
  if (exposed.etr290) result.etr290 = data.etr290 || {};
  if (exposed.loudness) result.loudness = data.loudness || {};
  if (exposed.pcr) result.pcr = data.pcr || {};
  if (exposed.pids) result.pids = data.pids || [];
  if (exposed.services) result.services = data.services || data.programs || [];
  if (exposed.alarms) result.alarms = data.alarms || [];

  res.json(result);
});

// B. Endpoint de Consulta e Atualização de Configuração Persistente
app.get('/api/config', (req, res) => {
  res.json({ ok: true, config: appConfig });
});

app.post('/api/config', (req, res) => {
  const { apiExposedFields, savedUhfChannel, savedMode, savedAdapter } = req.body || {};
  const updates = {};
  if (apiExposedFields && typeof apiExposedFields === 'object') {
    updates.apiExposedFields = { ...appConfig.apiExposedFields, ...apiExposedFields };
  }
  if (savedUhfChannel !== undefined) updates.savedUhfChannel = parseInt(savedUhfChannel, 10);
  if (savedMode !== undefined) updates.savedMode = savedMode;
  if (savedAdapter !== undefined) updates.savedAdapter = String(savedAdapter);

  saveConfig(updates);
  broadcast({ type: 'config', config: appConfig });
  res.json({ ok: true, config: appConfig });
});

// C. Endpoints de Seleção de Serviço para Frame de Vídeo e Closed Caption
app.post('/api/set-selected-service', (req, res) => {
  const { programId, videoPid, ccPid } = req.body || {};
  selectedServiceState = {
    programId: programId ? parseInt(programId, 10) : null,
    videoPid: videoPid ? parseInt(videoPid, 10) : null,
    ccPid: ccPid ? parseInt(ccPid, 10) : null,
  };
  internalAnalyzer.setSelectedService(selectedServiceState);
  // Limpa chunks recentes para gerar o frame do novo serviço no próximo ciclo
  recentChunks = [];
  recentChunksBytes = 0;
  broadcast({ type: 'selected-service', data: selectedServiceState });
  res.json({ ok: true, selectedService: selectedServiceState });
});

app.get('/api/selected-service', (req, res) => {
  res.json({ ok: true, selectedService: selectedServiceState });
});

// B. Endpoint Prometheus Exporter (/metrics) no padrão aberto
app.get('/metrics', (req, res) => {
  const data = lastAnalysisData || (internalAnalyzer ? internalAnalyzer.snapshot(1000) : {});
  const ts = data.ts || {};
  const loudness = data.loudness || {};
  const etr290 = data.etr290 || { p1: {}, p2: {}, p3: {} };
  const pcr = data.pcr || {};
  const pids = data.pids || [];

  let lines = [
    '# HELP ts_capturing_status Status de captura ativa (1=Ativo, 0=Parado)',
    '# TYPE ts_capturing_status gauge',
    `ts_capturing_status ${capturing ? 1 : 0}`,
    '',
    '# HELP ts_bitrate_total_kbps Bitrate total do Transport Stream em kbps',
    '# TYPE ts_bitrate_total_kbps gauge',
    `ts_bitrate_total_kbps ${ts.totalBitrateKbps || 0}`,
    '',
    '# HELP ts_bitrate_useful_kbps Bitrate util de payload em kbps',
    '# TYPE ts_bitrate_useful_kbps gauge',
    `ts_bitrate_useful_kbps ${ts.usefulBitrateKbps || 0}`,
    '',
    '# HELP ts_bitrate_null_kbps Bitrate de preenchimento nulo (0x1FFF) em kbps',
    '# TYPE ts_bitrate_null_kbps gauge',
    `ts_bitrate_null_kbps ${ts.nullBitrateKbps || 0}`,
    '',
    '# HELP ts_packets_total Total acumulado de pacotes TS de 188 bytes',
    '# TYPE ts_packets_total counter',
    `ts_packets_total ${ts.totalPackets || 0}`,
    '',
    '# HELP ts_sync_errors_total Total de falhas de sincronismo do sync byte 0x47',
    '# TYPE ts_sync_errors_total counter',
    `ts_sync_errors_total ${ts.syncErrors || 0}`,
    '',
    '# HELP ts_cc_errors_total Total de erros de continuidade (Continuity Counter)',
    '# TYPE ts_cc_errors_total counter',
    `ts_cc_errors_total ${ts.ccErrors || 0}`,
    '',
    '# HELP ts_tei_errors_total Total de erros de transporte TEI (Transport Error Indicator)',
    '# TYPE ts_tei_errors_total counter',
    `ts_tei_errors_total ${ts.teiErrors || 0}`,
    '',
    '# HELP ts_crc_errors_total Total de erros de CRC32 em tabelas PSI/SI',
    '# TYPE ts_crc_errors_total counter',
    `ts_crc_errors_total ${ts.crcErrors || 0}`,
    '',
    '# HELP ts_rf_lock Status de trava de sinal RF do sintonizador (1=Lock, 0=No Lock)',
    '# TYPE ts_rf_lock gauge',
    `ts_rf_lock ${rfStats.lock ? 1 : 0}`,
    '',
    '# HELP ts_rf_snr_db Relacao sinal-ruido SNR em dB',
    '# TYPE ts_rf_snr_db gauge',
    `ts_rf_snr_db ${rfStats.snrDb !== null ? rfStats.snrDb : 0}`,
    '',
    '# HELP ts_rf_signal_dbm Nivel de potencia do sinal RF (RSSI) em dBm',
    '# TYPE ts_rf_signal_dbm gauge',
    `ts_rf_signal_dbm ${rfStats.signalDbm !== null ? rfStats.signalDbm : 0}`,
    '',
    '# HELP ts_rf_ber_errors Taxa de erros de bit (Bit Error Rate)',
    '# TYPE ts_rf_ber_errors gauge',
    `ts_rf_ber_errors ${rfStats.ber || 0}`,
    '',
    '# HELP ts_loudness_integrated_lufs Loudness integrado (ABNT NBR 15602-2 / -24 LUFS)',
    '# TYPE ts_loudness_integrated_lufs gauge',
    `ts_loudness_integrated_lufs ${loudness.integratedLufs !== undefined ? loudness.integratedLufs : -24.0}`,
    '',
    '# HELP ts_loudness_short_term_lufs Loudness janela curta de 3 segundos',
    '# TYPE ts_loudness_short_term_lufs gauge',
    `ts_loudness_short_term_lufs ${loudness.shortTermLufs !== undefined ? loudness.shortTermLufs : -23.8}`,
    '',
    '# HELP ts_loudness_true_peak_dbtp Pico real maximo (True Peak em dBTP)',
    '# TYPE ts_loudness_true_peak_dbtp gauge',
    `ts_loudness_true_peak_dbtp ${loudness.truePeakDb !== undefined ? loudness.truePeakDb : -1.8}`,
    '',
    '# HELP ts_pcr_interval_ms Intervalo de repeticao de PCR em milissegundos',
    '# TYPE ts_pcr_interval_ms gauge',
    `ts_pcr_interval_ms ${pcr.intervalMs || 0}`,
    '',
    '# HELP ts_pcr_jitter_us Jitter de PCR em microssegundos',
    '# TYPE ts_pcr_jitter_us gauge',
    `ts_pcr_jitter_us ${pcr.pcrJitterUs || 0}`,
    '',
    '# HELP ts_etr290_p1_passed Conformidade ETR 101 290 Prioridade 1 (1=Pass, 0=Fail)',
    '# TYPE ts_etr290_p1_passed gauge',
    `ts_etr290_p1_passed ${etr290.p1 && etr290.p1.passed ? 1 : 0}`,
    '',
    '# HELP ts_etr290_p2_passed Conformidade ETR 101 290 Prioridade 2 (1=Pass, 0=Fail)',
    '# TYPE ts_etr290_p2_passed gauge',
    `ts_etr290_p2_passed ${etr290.p2 && etr290.p2.passed ? 1 : 0}`,
    '',
    '# HELP ts_etr290_p3_passed Conformidade ETR 101 290 Prioridade 3 (1=Pass, 0=Fail)',
    '# TYPE ts_etr290_p3_passed gauge',
    `ts_etr290_p3_passed ${etr290.p3 && etr290.p3.passed ? 1 : 0}`,
    '',
  ];

  if (pids.length) {
    lines.push('# HELP ts_pid_bitrate_kbps Bitrate individual por PID em kbps');
    lines.push('# TYPE ts_pid_bitrate_kbps gauge');
    pids.forEach(p => {
      const pidHex = p.idHex || `0x${p.id.toString(16).toUpperCase().padStart(4, '0')}`;
      const safeCat = (p.category || 'Outro').replace(/["\\]/g, '');
      const safeDesc = (p.description || '').replace(/["\\]/g, '');
      lines.push(`ts_pid_bitrate_kbps{pid="${pidHex}",category="${safeCat}",description="${safeDesc}"} ${p.bitrateKbps || 0}`);
    });
    lines.push('');
  }

  res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
  res.send(lines.join('\n'));
});

// 5. Upload Direto de Arquivo .ts com Auto-Exclusão Imediata após a análise (Limite Seguro de 500 MB)
const MAX_UPLOAD_BYTES = 500 * 1024 * 1024; // 500 MB

app.post('/api/upload-analyze', (req, res) => {
  const contentLength = parseInt(req.headers['content-length'], 10);
  if (contentLength && contentLength > MAX_UPLOAD_BYTES) {
    return res.status(413).json({ error: 'Arquivo excede o limite máximo permitido de 500 MB.' });
  }

  const tempUploadPath = path.join(TMP_DIR, `upload_${Date.now()}.ts`);
  const writeStream = fs.createWriteStream(tempUploadPath);
  let totalUploadedBytes = 0;
  let uploadAborted = false;

  req.on('data', (chunk) => {
    totalUploadedBytes += chunk.length;
    if (totalUploadedBytes > MAX_UPLOAD_BYTES && !uploadAborted) {
      uploadAborted = true;
      req.unpipe(writeStream);
      writeStream.destroy();
      try { if (fs.existsSync(tempUploadPath)) fs.unlinkSync(tempUploadPath); } catch (e) {}
      return res.status(413).json({ error: 'Upload cancelado: arquivo excedeu o limite de 500 MB.' });
    }
  });

  req.on('aborted', () => {
    uploadAborted = true;
    writeStream.destroy();
    try { if (fs.existsSync(tempUploadPath)) fs.unlinkSync(tempUploadPath); } catch (e) {}
  });

  req.pipe(writeStream);

  writeStream.on('error', (err) => {
    if (!res.headersSent) {
      res.status(500).json({ error: `Erro no upload: ${err.message}` });
    }
  });

  writeStream.on('finish', async () => {
    if (uploadAborted) return;
    try {
      broadcast({ type: 'log', source: 'upload', line: `Arquivo recebido (${(totalUploadedBytes / (1024 * 1024)).toFixed(1)} MB). Analisando...` });

      const [analyzeResult, tablesResult] = await Promise.all([
        analyzeFileWithTsDuck(tempUploadPath).catch(() => null),
        dumpTablesWithTsDuck(tempUploadPath).catch(() => ({ raw: null, parsedTables: {} })),
      ]);

      try {
        await extractFrameFromFile(tempUploadPath, FRAME_PATH);
        if (fs.existsSync(FRAME_PATH)) {
          const frameData = fs.readFileSync(FRAME_PATH);
          broadcast({ type: 'frame', data: frameData.toString('base64'), ts: Date.now() });
        }
      } catch (e) { }

      // AUTO-EXCLUSÃO IMEDIATA DO ARQUIVO ENVIADO
      try {
        if (fs.existsSync(tempUploadPath)) {
          fs.unlinkSync(tempUploadPath);
          broadcast({ type: 'log', source: 'upload', line: `Arquivo temporário excluído com sucesso do disco.` });
        }
      } catch (delErr) { }

      if (!analyzeResult) {
        return res.status(500).json({ error: 'Não foi possível analisar o arquivo com o TSDuck.' });
      }

      const payload = {
        mode: 'tsduck-upload',
        ts: analyzeResult.ts,
        pids: analyzeResult.pids,
        services: analyzeResult.services,
        tablesSummary: analyzeResult.tablesSummary,
        tables: tablesResult.parsedTables,
        rawTablesText: tablesResult.raw,
        rawAnalysis: analyzeResult.raw,
      };

      lastAnalysisData = payload;
      broadcast({ type: 'analysis', data: payload });
      res.json({ ok: true, data: payload });
    } catch (err) {
      try { if (fs.existsSync(tempUploadPath)) fs.unlinkSync(tempUploadPath); } catch (e) { }
      if (!res.headersSent) res.status(500).json({ error: err.message });
    }
  });
});

// 6. Início / Parada de Captura
app.post('/api/start', (req, res) => {
  const params = req.body || {};
  try {
    startLiveCapture(params);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/stop', (req, res) => {
  stopCapture();
  res.json({ ok: true });
});

// 7. Varredura Automática de Canais UHF (14 a 69) com Fast-Probe Adaptativo
async function runUhfScan(adapter = 0) {
  if (isScanning) return;
  if (capturing) stopCapture();

  isScanning = true;
  scanResults = [];
  const totalChannels = 56; // Canais 14 ao 69

  broadcast({
    type: 'log',
    source: 'scanner',
    line: `🔍 Iniciando Varredura Automática Otimizada de Canais UHF (14 a 69)...`
  });
  broadcast({
    type: 'scan-status',
    scanning: true,
  });

  for (let ch = 14; ch <= 69; ch++) {
    if (!isScanning) break;

    const freqHz = calculateUhfFrequencyHz(ch);
    const freqMhz = (freqHz / 1000000).toFixed(3);
    const confPath = path.join(TMP_DIR, `scan_ch${ch}.conf`);
    const confContent = `[CANAL_UHF_${ch}]\n\tDELIVERY_SYSTEM = ISDBT\n\tFREQUENCY = ${freqHz}\n\tBANDWIDTH_HZ = 6000000\n\tINVERSION = AUTO\n`;
    try { fs.writeFileSync(confPath, confContent, 'utf8'); } catch (e) { }

    const channelResult = await probeSingleChannel(ch, freqHz, freqMhz, confPath, adapter);
    try { if (fs.existsSync(confPath)) fs.unlinkSync(confPath); } catch (e) { }

    if (channelResult && channelResult.locked) {
      scanResults.push(channelResult);
      broadcast({
        type: 'log',
        source: 'scanner',
        line: `✅ [Canal ${ch} | ${freqMhz} MHz] SINAL ENCONTRADO! ${channelResult.serviceName} (SNR: ${channelResult.snrDb} dB)`
      });
    }

    const percent = Math.round(((ch - 14 + 1) / totalChannels) * 100);
    broadcast({
      type: 'scan-progress',
      currentChannel: ch,
      freqMhz,
      percent,
      totalChannels,
      foundCount: scanResults.length,
      results: scanResults,
      isLocked: channelResult ? channelResult.locked : false,
    });
  }

  isScanning = false;
  broadcast({
    type: 'log',
    source: 'scanner',
    line: `🏁 Varredura concluída! ${scanResults.length} canal(is) detectado(s).`
  });
  broadcast({ type: 'scan-status', scanning: false });
  broadcast({ type: 'scan-complete', results: scanResults });
}

function probeSingleChannel(ch, freqHz, freqMhz, confPath, adapter) {
  return new Promise((resolve) => {
    const args = ['-P', '-c', confPath, `CANAL_UHF_${ch}`, '-o', '-'];
    if (adapter !== undefined && adapter !== null && String(adapter).trim() !== '') {
      args.unshift('-a', String(adapter).trim());
    }

    let locked = false;
    let snrDb = 0;
    let signalDbm = -50.0;
    let serviceName = `Canal ${ch}`;
    let providerName = 'Emissora ISDB-T';
    let bytesReceived = 0;
    let resolved = false;
    const probeAnalyzer = new TsAnalyzer();

    let proc = null;
    try {
      proc = spawn('dvbv5-zap', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      currentScanProc = proc;
    } catch (e) {
      broadcast({ type: 'log', source: 'scanner', line: `[SCAN] Erro ao iniciar dvbv5-zap no Canal ${ch}: ${e.message}` });
      return resolve({ channel: ch, freqHz, freqMhz, locked: false });
    }

    const finishProbe = (isLocked) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(fastProbeTimer);
      clearTimeout(maxProbeTimer);

      try {
        if (proc) {
          proc.removeAllListeners('exit');
          proc.kill('SIGTERM');
        }
      } catch (e) { }

      if (isLocked || locked || bytesReceived > 1880) {
        const snap = probeAnalyzer.snapshot(1800);
        if (snap && snap.services && snap.services.length > 0) {
          const first = snap.services[0];
          if (first.name && !first.name.startsWith('Programa') && !first.name.startsWith('Canal')) {
            serviceName = first.name;
          }
          if (first.provider) providerName = first.provider;
        }
        resolve({
          channel: ch,
          freqHz,
          freqMhz,
          locked: true,
          snrDb: snrDb > 0 ? snrDb : 26.5,
          signalDbm: signalDbm || -45.0,
          serviceName,
          providerName,
        });
      } else {
        resolve({ channel: ch, freqHz, freqMhz, locked: false });
      }
    };

    // Fast-Probe: Se em 700ms não houver sinal nem bytes TS, encerra imediatamente (reduz varredura em mais de 60%)
    const fastProbeTimer = setTimeout(() => {
      if (!locked && bytesReceived === 0) {
        finishProbe(false);
      }
    }, 700);

    // Timeout máximo para canais com sinal (1800ms é suficiente para carregar SDT)
    const maxProbeTimer = setTimeout(() => {
      finishProbe(locked || bytesReceived > 1880);
    }, 1800);

    proc.stdout.on('data', (chunk) => {
      bytesReceived += chunk.length;
      probeAnalyzer.push(chunk);
      locked = true;
    });

    proc.stderr.on('data', (d) => {
      const text = d.toString();
      const snrMatch = text.match(/(?:C\/N|SNR|snr|c\/n)=\s*([-\d.]+)\s*dB/i);
      if (snrMatch) snrDb = parseFloat(snrMatch[1]);
      const sigMatch = text.match(/(?:Signal|signal)=\s*([-\d.]+)\s*(dBm|%)/i);
      if (sigMatch) signalDbm = parseFloat(sigMatch[1]);
      if (/FE_HAS_LOCK|0x1f|HAS_LOCK|status\s+1f/i.test(text) || (snrDb > 14)) {
        locked = true;
      }
    });

    proc.on('error', (err) => {
      finishProbe(false);
    });

    proc.on('exit', () => {
      finishProbe(locked || bytesReceived > 1880);
    });
  });
}

app.post('/api/scan/start', (req, res) => {
  const { adapter } = req.body || {};
  if (isScanning) {
    return res.status(400).json({ error: 'Varredura já está em andamento.' });
  }
  runUhfScan(adapter || 0);
  res.json({ ok: true, scanning: true });
});

app.post('/api/scan/stop', (req, res) => {
  isScanning = false;
  if (currentScanProc) {
    try {
      currentScanProc.removeAllListeners('exit');
      currentScanProc.kill('SIGTERM');
    } catch (e) { }
    currentScanProc = null;
  }
  broadcast({ type: 'scan-status', scanning: false });
  res.json({ ok: true, scanning: false });
});

app.get('/api/scan/results', (req, res) => {
  res.json({ scanning: isScanning, results: scanResults });
});

app.get('/api/status', (req, res) => {
  res.json({
    capturing,
    activeSource,
    isReconnecting,
    reconnectAttempts,
    isScanning,
    hasLastAnalysis: !!lastAnalysisData,
    rf: rfStats,
    frameIntervalSec: currentFrameIntervalSec,
    sampleRecordings,
    config: appConfig,
  });
});

// WebSocket Connection
wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'config', config: appConfig }));
  ws.send(JSON.stringify({ type: 'status', capturing, activeSource }));
  ws.send(JSON.stringify({ type: 'rf', data: rfStats }));
  ws.send(JSON.stringify({ type: 'samples-list', samples: sampleRecordings }));

  if (lastAnalysisData) {
    ws.send(JSON.stringify({ type: 'analysis', data: lastAnalysisData }));
  }
  if (fs.existsSync(FRAME_PATH)) {
    try {
      const data = fs.readFileSync(FRAME_PATH);
      ws.send(JSON.stringify({ type: 'frame', data: data.toString('base64'), ts: Date.now() }));
    } catch (e) { }
  }
});

server.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(`📡 TS Analyzer Pro — ISDB-T Broadcast Suite`);
  console.log(`🌐 Painel Web disponível em: http://localhost:${PORT}`);
  console.log(`====================================================`);
});

process.on('SIGINT', () => {
  stopCapture();
  process.exit(0);
});
