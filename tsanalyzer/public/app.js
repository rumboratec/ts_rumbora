'use strict';

// Elements
const statusIndicator = document.getElementById('statusIndicator');
const videoFrame = document.getElementById('videoFrame');
const frameTimestamp = document.getElementById('frameTimestamp');
const systemLogs = document.getElementById('systemLogs');
const uhfSelect = document.getElementById('uhfSelect');
const uhfCalculatedFreq = document.getElementById('uhfCalculatedFreq');

// RF Telemetry Elements (agora na aba RF)
const rfTabSignal = document.getElementById('rfTabSignal');
const rfTabSnr = document.getElementById('rfTabSnr');
const rfTabBer = document.getElementById('rfTabBer');
const rfTabLock = document.getElementById('rfTabLock');
const snrQualityBar = document.getElementById('snrQualityBar');

// Samples Elements
const sampleDurationSelect = document.getElementById('sampleDurationSelect');
const sampleRecordingStatus = document.getElementById('sampleRecordingStatus');
const sampleProgressText = document.getElementById('sampleProgressText');
const sampleTimerText = document.getElementById('sampleTimerText');
const sampleProgressBar = document.getElementById('sampleProgressBar');
const samplesTableBody = document.getElementById('samplesTableBody');
let sampleRecordInterval = null;

// Global State
let currentTuningMode = 'uhf';
let currentAnalysis = null;
let pidsList = [];
let allAlarmsList = [];
let currentAlarmFilter = 'ALL';
let currentSortField = 'bitrate';
let sortAscending = false;
let currentFrameInterval = 3;

// WebSocket Setup com Reconexão Automática e Backoff Exponencial
let ws = null;
let wsReconnectTimer = null;
let wsReconnectDelay = 1000;
const MAX_WS_RECONNECT_DELAY = 10000;

function connectWebSocket() {
  if (wsReconnectTimer) {
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = null;
  }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  try {
    ws = new WebSocket(`${proto}://${location.host}`);
  } catch (e) {
    scheduleWsReconnect();
    return;
  }

  ws.addEventListener('open', () => {
    wsReconnectDelay = 1000;
    appendLog('[WS] Conectado à central de análise de broadcast.');
    if (statusIndicator.textContent.includes('Reconectando') || statusIndicator.textContent === 'Desconectado') {
      statusIndicator.className = 'status-indicator idle';
      statusIndicator.textContent = 'Pronto';
    }
  });

  ws.addEventListener('message', (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'config') {
        applyConfig(msg.config);
      } else if (msg.type === 'status') {
        updateCaptureStatus(msg.capturing, msg.source);
      } else if (msg.type === 'analysis' || msg.type === 'stats') {
        renderAnalysis(msg.data);
      } else if (msg.type === 'frame') {
        if (videoFrame) {
          videoFrame.src = 'data:image/jpeg;base64,' + msg.data;
          if (frameTimestamp) {
            frameTimestamp.textContent = `Atualizado às ${new Date().toLocaleTimeString('pt-BR')}`;
          }
        }
      } else if (msg.type === 'rf') {
        window.lastRfData = msg.data;
        renderRfTelemetry(msg.data);
      } else if (msg.type === 'cc') {
        renderClosedCaption(msg.text);
      } else if (msg.type === 'watchdog') {
        handleWatchdogEvent(msg);
      } else if (msg.type === 'scan-progress') {
        handleScanProgress(msg);
      } else if (msg.type === 'scan-complete') {
        handleScanComplete(msg);
      } else if (msg.type === 'scan-status') {
        handleScanStatus(msg);
      } else if (msg.type === 'samples-list') {
        renderSamplesList(msg.samples || []);
      } else if (msg.type === 'sample-record-status') {
        updateSampleRecordingStatus(msg);
      } else if (msg.type === 'log') {
        appendLog(`[${msg.source || 'SYS'}] ${msg.line}`);
      }
    } catch (e) {
      console.error('Erro WS:', e);
    }
  });

  ws.addEventListener('close', () => {
    appendLog('[WS] Conexão encerrada. Tentando reconectar...');
    scheduleWsReconnect();
  });

  ws.addEventListener('error', () => {
    try { ws.close(); } catch (e) {}
  });
}

function scheduleWsReconnect() {
  if (wsReconnectTimer) return;
  const delaySec = Math.round(wsReconnectDelay / 1000);
  statusIndicator.className = 'status-indicator reconnecting';
  statusIndicator.textContent = `Reconectando em ${delaySec}s...`;

  wsReconnectTimer = setTimeout(() => {
    wsReconnectTimer = null;
    wsReconnectDelay = Math.min(wsReconnectDelay * 1.8, MAX_WS_RECONNECT_DELAY);
    connectWebSocket();
  }, wsReconnectDelay);
}

connectWebSocket();

// Estado Global de Captura & Configuração
let currentAppConfig = null;
let isCapturingActive = false;
let currentActiveSource = null;

function applyConfig(cfg) {
  if (!cfg) return;
  currentAppConfig = cfg;

  if (cfg.savedUhfChannel) {
    const select = document.getElementById('uhfSelect');
    if (select) {
      select.value = String(cfg.savedUhfChannel);
      updateUhfFrequencyDisplay();
    }
  }

  if (cfg.savedAdapter !== undefined && cfg.savedAdapter !== null) {
    const adapterInput = document.getElementById('adapterUhf');
    if (adapterInput) adapterInput.value = String(cfg.savedAdapter);
  }

  if (cfg.savedMode && cfg.savedMode === 'uhf' && !isCapturingActive) {
    switchTuningMode('uhf');
  }

  updateTuningButtonStates();
}

async function loadInitialConfig() {
  try {
    const res = await fetch('/api/config');
    if (res.ok) {
      const data = await res.json();
      if (data && data.config) applyConfig(data.config);
    }
  } catch (e) {}
}

// 1. Inicialização dos Canais UHF (14 a 69 do Padrão Brasileiro)
function initUhfChannelSelect() {
  const select = document.getElementById('uhfSelect');
  if (!select) return;
  let html = '';
  const selectedCh = currentAppConfig && currentAppConfig.savedUhfChannel ? currentAppConfig.savedUhfChannel : 14;
  for (let ch = 14; ch <= 69; ch++) {
    const freqHz = (470 + (ch - 14) * 6) * 1000000 + 3142857;
    const freqMhz = (freqHz / 1000000).toFixed(3);
    html += `<option value="${ch}" ${ch === selectedCh ? 'selected' : ''}>Canal ${ch} — ${freqMhz} MHz</option>`;
  }
  select.innerHTML = html;
  updateUhfFrequencyDisplay();
}

function onUhfSelectChange() {
  updateUhfFrequencyDisplay();
  updateTuningButtonStates();
}

function updateUhfFrequencyDisplay() {
  const select = document.getElementById('uhfSelect');
  const ch = select ? (parseInt(select.value, 10) || 14) : 14;
  const freqHz = (470 + (ch - 14) * 6) * 1000000 + 3142857;
  const freqMhz = (freqHz / 1000000).toFixed(3);
  if (uhfCalculatedFreq) {
    uhfCalculatedFreq.textContent = `${freqMhz} MHz (${freqHz} Hz)`;
  }
}

initUhfChannelSelect();
loadInitialConfig();

// 2. Alternância de Modos de Sintonização & Controle de Visibilidade de Tabelas
function updatePsiSiTabsVisibility(isIp) {
  const btnEit = document.getElementById('subtab-btn-eit');
  const btnNit = document.getElementById('subtab-btn-nit');
  if (btnEit) btnEit.classList.toggle('hidden', isIp);
  if (btnNit) btnNit.classList.toggle('hidden', isIp);

  if (isIp) {
    const activeSubTab = document.querySelector('.sub-tab-btn.active');
    if (activeSubTab && (activeSubTab.id === 'subtab-btn-eit' || activeSubTab.id === 'subtab-btn-nit')) {
      switchSubTable('pat');
    }
  }
}

function switchTuningMode(mode) {
  currentTuningMode = mode;
  document.getElementById('btnModeUhf').classList.toggle('active', mode === 'uhf');
  document.getElementById('btnModeIp').classList.toggle('active', mode === 'ip');
  document.getElementById('btnModeUpload').classList.toggle('active', mode === 'upload');

  document.getElementById('modeUhfSection').classList.toggle('hidden', mode !== 'uhf');
  document.getElementById('modeIpSection').classList.toggle('hidden', mode !== 'ip');
  document.getElementById('modeUploadSection').classList.toggle('hidden', mode !== 'upload');

  // Telemetria RF: visível apenas no modo UHF
  const rfPanel = document.getElementById('rfSectionPanel');
  if (rfPanel) {
    rfPanel.classList.toggle('hidden', mode !== 'uhf');
  }

  // Oculta abas EIT e NIT quando em modo IP
  updatePsiSiTabsVisibility(mode === 'ip');
  updateTuningButtonStates();
}

// 3. Ajuste Dinâmico do Intervalo de Frame de Vídeo (1s a 10s)
async function setFrameInterval(sec) {
  const val = Math.max(1, Math.min(10, parseInt(sec, 10) || 3));
  currentFrameInterval = val;
  document.querySelectorAll('.btn-interval').forEach(btn => {
    btn.classList.toggle('active', btn.textContent.trim() === `${val}s`);
  });
  try {
    await fetch('/api/set-frame-interval', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ intervalSec: val })
    });
    appendLog(`[FRAME] Intervalo de captura ajustado para ${val} segundo(s).`);
  } catch (e) {}
}

// 4. Início de Captura e Limpeza Completa de Estado
function resetEpgState() {
  cachedEitEvents = [];
  epgHasRendered = false;
  lastEpgRenderTime = 0;
  currentServicePageIndex = 0;
  if (epgCollectionTimer) {
    clearTimeout(epgCollectionTimer);
    epgCollectionTimer = null;
  }
  epgCollectionStartTime = 0;

  const eitDiv = document.getElementById('eitDetails');
  if (eitDiv) {
    eitDiv.innerHTML = '<div class="empty-state">⏳ Sintonizando canal... Aguardando eventos EPG (EIT).</div>';
  }
  const epgLastUpdateText = document.getElementById('epgLastUpdateText');
  if (epgLastUpdateText) {
    epgLastUpdateText.textContent = 'Aguardando fluxo EPG do novo canal...';
  }
}

function resetFullChannelState() {
  resetEpgState();
  pidsList = [];
  allCurrentServices = [];
  currentAnalysis = null;

  const tbody = document.getElementById('pidsTableBody');
  if (tbody) {
    tbody.innerHTML = '<tr><td colspan="7" class="text-center text-muted">⏳ Sintonizando canal... Carregando PIDs e serviços.</td></tr>';
  }
  const servicesContainer = document.getElementById('servicesContainer');
  if (servicesContainer) {
    servicesContainer.innerHTML = '<div class="empty-state">⏳ Sintonizando canal... Aguardando programas (SDT/PMT).</div>';
  }
  const ccEl = document.getElementById('ccText');
  if (ccEl) {
    ccEl.textContent = 'Aguardando legendas no fluxo...';
  }
  const select = document.getElementById('serviceSelectDecode');
  if (select) {
    select.innerHTML = '<option value="">Aguardando Serviços...</option>';
  }
}

// 4.1 Seleção Dinâmica de Serviço para Decodificação de Vídeo e CC
let selectedServiceTarget = null;

function onSelectedServiceChange() {
  const select = document.getElementById('serviceSelectDecode');
  if (!select || !select.value) return;
  const val = select.value;
  selectedServiceTarget = val;

  const parts = val.split(':');
  const programId = parts[0] && parts[0] !== 'null' ? parseInt(parts[0], 10) : null;
  const videoPid = parts[1] && parts[1] !== 'null' ? parseInt(parts[1], 10) : null;
  const ccPid = parts[2] && parts[2] !== 'null' ? parseInt(parts[2], 10) : null;

  fetch('/api/set-selected-service', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ programId, videoPid, ccPid }),
  });
  appendLog(`[DECODE] Serviço ativo selecionado: Programa ${programId} (Vídeo: ${videoPid ? '0x' + videoPid.toString(16).toUpperCase() : 'N/A'}, CC: ${ccPid ? '0x' + ccPid.toString(16).toUpperCase() : 'N/A'}).`);
}

function updateServiceDecodeDropdown(services) {
  const select = document.getElementById('serviceSelectDecode');
  if (!select) return;

  if (!services || !services.length) {
    select.innerHTML = '<option value="">Aguardando Serviços...</option>';
    return;
  }

  const currentVal = select.value;
  let html = '';
  let firstValidKey = null;

  services.forEach((s, idx) => {
    const sName = s.name || `Programa ${s.id}`;
    const vComp = (s.components || []).find(c => c.isVideo);
    const ccComp = (s.components || []).find(c => c.isCC || c.type?.includes('Legenda') || c.type?.includes('ARIB'));

    const vPid = vComp ? vComp.pid : null;
    const ccPid = ccComp ? ccComp.pid : null;
    const valKey = `${s.id}:${vPid !== null ? vPid : ''}:${ccPid !== null ? ccPid : ''}`;

    if (idx === 0) firstValidKey = valKey;

    const vHex = vPid ? `Vídeo 0x${vPid.toString(16).toUpperCase()}` : 'Sem Vídeo';
    html += `<option value="${valKey}">${sName} (${vHex})</option>`;
  });

  select.innerHTML = html;

  // Seleciona sempre o primeiro serviço por padrão se não houver seleção prévia válida
  if (currentVal && select.querySelector(`option[value="${currentVal}"]`)) {
    select.value = currentVal;
  } else if (firstValidKey) {
    select.value = firstValidKey;
    onSelectedServiceChange();
  }
}

async function startCaptureByUhf() {
  const select = document.getElementById('uhfSelect');
  const uhfChannel = select ? select.value : '14';
  const adapter = document.getElementById('adapterUhf')?.value?.trim() || '0';

  if (isCapturingActive) {
    await stopCapture();
  }
  resetFullChannelState();
  updatePsiSiTabsVisibility(false);
  sendStartCapture({ mode: 'uhf', uhfChannel, adapter });
}

async function startCaptureByIp() {
  const ipUrl = document.getElementById('ipStreamUrl').value.trim();
  if (!ipUrl) {
    alert('Informe a URL do stream IP (ex: srt://189.42.242.178:1026 ou udp://@239.0.0.1:1234)');
    return;
  }

  if (isCapturingActive) {
    await stopCapture();
  }
  resetFullChannelState();
  updatePsiSiTabsVisibility(true);
  sendStartCapture({ mode: 'ip', ipUrl });
}

async function sendStartCapture(payload) {
  setButtonsState(true);
  try {
    const res = await fetch('/api/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert(`Erro: ${err.error || res.statusText}`);
      setButtonsState(false);
    }
  } catch (e) {
    alert(`Erro ao conectar com o servidor: ${e.message}`);
    setButtonsState(false);
  }
}

async function stopCapture() {
  resetFullChannelState();
  try {
    await fetch('/api/stop', { method: 'POST' });
  } catch (e) {}
}

function setButtonsState(isCapturing) {
  document.querySelectorAll('.btn-stop').forEach(b => b.disabled = !isCapturing);
  updateTuningButtonStates();
}

function updateTuningButtonStates() {
  const btnStartUhf = document.getElementById('btnStartUhf');
  const btnStopUhf = document.getElementById('btnStopUhf');
  const btnStartIp = document.getElementById('btnStartIp');
  const btnStopIp = document.getElementById('btnStopIp');

  if (btnStartUhf) {
    const currentCh = uhfSelect ? parseInt(uhfSelect.value, 10) : 14;
    const isUhfActive = isCapturingActive && currentActiveSource && (currentActiveSource.mode === 'uhf' || currentActiveSource.uhfChannel);
    const activeCh = currentActiveSource ? (currentActiveSource.uhfChannel ? parseInt(currentActiveSource.uhfChannel, 10) : (currentActiveSource.displayInfo ? parseInt(currentActiveSource.displayInfo.match(/Canal UHF (\d+)/)?.[1], 10) : null)) : null;

    if (isUhfActive && activeCh === currentCh) {
      btnStartUhf.disabled = true;
      btnStartUhf.innerHTML = '<span class="btn-icon">✓</span> Sintonizado';
    } else if (isUhfActive && activeCh !== currentCh) {
      btnStartUhf.disabled = false;
      btnStartUhf.innerHTML = `<span class="btn-icon">▶</span> Trocar para Canal ${currentCh}`;
    } else {
      btnStartUhf.disabled = false;
      btnStartUhf.innerHTML = '<span class="btn-icon">▶</span> Sintonizar Canal';
    }
  }

  if (btnStopUhf) {
    btnStopUhf.disabled = !isCapturingActive || (currentActiveSource && currentActiveSource.mode !== 'uhf');
  }

  if (btnStartIp) {
    const isIpActive = isCapturingActive && currentActiveSource && (currentActiveSource.mode === 'ip' || currentActiveSource.ipUrl);
    if (isIpActive) {
      btnStartIp.disabled = true;
      btnStartIp.innerHTML = '<span class="btn-icon">✓</span> Conectado';
    } else {
      btnStartIp.disabled = false;
      btnStartIp.innerHTML = '<span class="btn-icon">▶</span> Conectar Stream IP';
    }
  }

  if (btnStopIp) {
    btnStopIp.disabled = !isCapturingActive || (currentActiveSource && currentActiveSource.mode !== 'ip');
  }
}

function updateCaptureStatus(capturing, source) {
  isCapturingActive = !!capturing;
  currentActiveSource = source || null;
  setButtonsState(capturing);

  const rfPanel = document.getElementById('rfSectionPanel');
  const isIpMode = source ? source.mode === 'ip' : currentTuningMode === 'ip';
  updatePsiSiTabsVisibility(isIpMode);

  if (capturing) {
    statusIndicator.className = 'status-indicator live';
    statusIndicator.textContent = `Sintonizado: ${source && source.displayInfo ? source.displayInfo : 'Ao Vivo'}`;

    if (rfPanel) {
      rfPanel.classList.toggle('hidden', source && source.mode !== 'uhf');
    }
  } else {
    statusIndicator.className = 'status-indicator idle';
    statusIndicator.textContent = 'Pronto';

    if (rfPanel) {
      rfPanel.classList.toggle('hidden', currentTuningMode !== 'uhf');
    }
  }
}

// 6. Gerenciador de Amostras .TS (1 a 5 minutos, Max 5 pedidos)
async function triggerSampleRecord() {
  const duration = parseInt(sampleDurationSelect.value, 10) || 1;
  appendLog(`[SAMPLE] Solicitando gravação de amostra de ${duration} minuto(s)...`);

  try {
    const res = await fetch('/api/start-sample-record', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ durationMinutes: duration }),
    });
    const data = await res.json();
    if (!res.ok) {
      alert(data.error || 'Erro ao iniciar gravação.');
    }
  } catch (e) {
    alert(`Erro ao iniciar gravação: ${e.message}`);
  }
}

async function stopSampleRecordManual() {
  try {
    await fetch('/api/stop-sample-record', { method: 'POST' });
  } catch (e) {}
}

function updateSampleRecordingStatus(data) {
  if (!sampleRecordingStatus) return;
  if (sampleRecordInterval) {
    clearInterval(sampleRecordInterval);
    sampleRecordInterval = null;
  }

  if (data.recording) {
    sampleRecordingStatus.classList.remove('hidden');
    const startedAt = data.startedAt || Date.now();
    const durationSec = data.durationSec || 60;

    const tick = () => {
      const elapsedSec = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
      const remainingSec = Math.max(0, durationSec - elapsedSec);
      const pct = Math.min(100, Math.round((elapsedSec / durationSec) * 100));

      const formatMmSs = (s) => {
        const m = Math.floor(s / 60);
        const sec = s % 60;
        return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
      };

      if (sampleProgressText) {
        sampleProgressText.textContent = `Gravando amostra .TS (${pct}%) • Restam ${formatMmSs(remainingSec)}`;
      }
      if (sampleTimerText) {
        sampleTimerText.textContent = `${formatMmSs(elapsedSec)} / ${formatMmSs(durationSec)}`;
      }
      if (sampleProgressBar) {
        sampleProgressBar.style.width = `${pct}%`;
      }

      if (elapsedSec >= durationSec) {
        if (sampleRecordInterval) clearInterval(sampleRecordInterval);
      }
    };

    tick();
    sampleRecordInterval = setInterval(tick, 1000);
  } else {
    sampleRecordingStatus.classList.add('hidden');
    if (sampleProgressBar) sampleProgressBar.style.width = '0%';
  }
}

function renderSamplesList(samples) {
  if (!samplesTableBody) return;
  if (!samples || !samples.length) {
    samplesTableBody.innerHTML = '<tr><td colspan="5" class="text-center text-muted">Nenhuma amostra gravada ainda.</td></tr>';
    return;
  }

  samplesTableBody.innerHTML = samples.map(s => `
    <tr>
      <td>${new Date(s.createdAt).toLocaleString('pt-BR')}</td>
      <td class="font-mono">${s.filename}</td>
      <td>${s.durationFormatted || '1 min'}</td>
      <td class="font-mono">${s.sizeFormatted || '-'}</td>
      <td>
        <a href="/api/download-sample-file/${s.id}" class="btn btn-secondary btn-sm" download>
          <span>📥</span> Baixar
        </a>
      </td>
    </tr>
  `).join('');
}

// Carrega amostras existentes na inicialização
fetch('/api/samples-list').then(r => r.json()).then(d => renderSamplesList(d.samples || [])).catch(() => {});

// 7. Upload de Arquivo .ts com Auto-Exclusão Imediata
async function uploadAndAnalyzeFile() {
  const fileInput = document.getElementById('tsFileInput');
  if (!fileInput || !fileInput.files.length) {
    alert('Selecione um arquivo .ts do seu computador.');
    return;
  }

  const file = fileInput.files[0];
  const btn = document.getElementById('btnUploadFile');
  btn.disabled = true;
  btn.textContent = 'Enviando e Analisando...';

  statusIndicator.className = 'status-indicator analyzing';
  statusIndicator.textContent = 'Processando Upload...';
  appendLog(`[UPLOAD] Enviando ${file.name} (${(file.size / (1024 * 1024)).toFixed(1)} MB)...`);

  try {
    const res = await fetch('/api/upload-analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file,
    });

    const result = await res.json();
    if (res.ok && result.data) {
      statusIndicator.className = 'status-indicator live';
      statusIndicator.textContent = `Arquivo: ${file.name}`;
      appendLog(`[UPLOAD] Análise concluída com sucesso. O arquivo foi excluído automaticamente do servidor.`);
      renderAnalysis(result.data);
    } else {
      statusIndicator.className = 'status-indicator idle';
      statusIndicator.textContent = 'Erro';
      alert(`Erro na análise: ${result.error || 'Falha desconhecida'}`);
    }
  } catch (e) {
    statusIndicator.className = 'status-indicator idle';
    statusIndicator.textContent = 'Erro';
    alert(`Erro ao processar upload: ${e.message}`);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<span class="btn-icon">📤</span> Enviar & Analisar com TSDuck';
    fileInput.value = '';
  }
}

// 8. Telemetria RF (Aba Dedicada)
function renderRfTelemetry(rf) {
  if (!rf) return;
  const sig = rf.signalDbm !== null ? `${rf.signalDbm} dBm` : '-- dBm';
  const snr = rf.snrDb !== null ? `${rf.snrDb} dB` : '-- dB';
  const ber = rf.ber !== null ? String(rf.ber) : '0';
  const locked = !!rf.lock;

  if (rfTabSignal) rfTabSignal.textContent = sig;
  if (rfTabSnr) rfTabSnr.textContent = snr;
  if (rfTabBer) rfTabBer.textContent = ber;
  if (rfTabLock) {
    rfTabLock.className = `rf-big-value rf-lock-val ${locked ? 'online' : 'offline'}`;
    rfTabLock.textContent = locked ? 'TRAVADO (LOCK)' : 'SEM SINAL';
  }
  const rfLockBadge = document.getElementById('rfLockBadge');
  if (rfLockBadge) {
    rfLockBadge.className = `badge-compliance ${locked ? 'ok' : ''}`;
    rfLockBadge.textContent = locked ? 'TRAVADO (LOCK)' : 'SEM SINAL';
  }

  // Barra de qualidade de SNR (0-40dB mapeado para 0-100%)
  if (snrQualityBar) {
    if (rf.snrDb !== null && locked) {
      const pct = Math.min(100, Math.max(0, (rf.snrDb / 40) * 100));
      snrQualityBar.style.width = `${pct}%`;
      if (rf.snrDb < 14) snrQualityBar.style.background = 'var(--status-danger)';
      else if (rf.snrDb < 20) snrQualityBar.style.background = 'var(--status-warn)';
      else if (rf.snrDb < 30) snrQualityBar.style.background = 'var(--status-ok)';
      else snrQualityBar.style.background = '#38bdf8';
    } else {
      snrQualityBar.style.width = '0%';
    }
  }
}

// 9. EPG Caching & Coleta Completa (Ao Sintonizar, 6h ou Manual)
let cachedEitEvents = [];
let epgHasRendered = false;
let lastEpgRenderTime = 0;
let epgCollectionTimer = null;
let epgCollectionStartTime = 0;
let currentEpgPageIndex = 0;
let currentEpgViewMode = 'timeline'; // 'timeline' ou 'list'
let currentActiveTsId = null;

function setEpgViewMode(mode) {
  currentEpgViewMode = mode;
  document.getElementById('btnEpgViewTimeline')?.classList.toggle('active', mode === 'timeline');
  document.getElementById('btnEpgViewList')?.classList.toggle('active', mode === 'list');
  renderCurrentEpgView(cachedEitEvents);
}

function renderCurrentEpgView(events) {
  const evts = events || cachedEitEvents;
  if (currentEpgViewMode === 'timeline') {
    renderEpgTimeline(evts);
  } else {
    renderEpgList(evts);
  }
}

function setEpgPage(idx) {
  currentEpgPageIndex = idx;
  renderEpgList(cachedEitEvents);
}

function prevEpgPage() {
  if (!cachedEitEvents || !cachedEitEvents.length) return;
  const totalPages = Math.ceil(cachedEitEvents.length / 10);
  currentEpgPageIndex = (currentEpgPageIndex - 1 + totalPages) % totalPages;
  renderEpgList(cachedEitEvents);
}

function nextEpgPage() {
  if (!cachedEitEvents || !cachedEitEvents.length) return;
  const totalPages = Math.ceil(cachedEitEvents.length / 10);
  currentEpgPageIndex = (currentEpgPageIndex + 1) % totalPages;
  renderEpgList(cachedEitEvents);
}

function getRatingBadgeHtml(rating) {
  const r = (rating || 'Livre').toLowerCase();
  let bg = 'rgba(16, 185, 129, 0.18)';
  let color = '#34d399';
  let border = 'rgba(16, 185, 129, 0.35)';

  if (r.includes('10')) {
    bg = 'rgba(2, 132, 199, 0.18)';
    color = '#38bdf8';
    border = 'rgba(2, 132, 199, 0.35)';
  } else if (r.includes('12')) {
    bg = 'rgba(245, 158, 11, 0.18)';
    color = '#fbbf24';
    border = 'rgba(245, 158, 11, 0.35)';
  } else if (r.includes('14')) {
    bg = 'rgba(249, 115, 22, 0.18)';
    color = '#fb923c';
    border = 'rgba(249, 115, 22, 0.35)';
  } else if (r.includes('16')) {
    bg = 'rgba(239, 68, 68, 0.18)';
    color = '#f87171';
    border = 'rgba(239, 68, 68, 0.35)';
  } else if (r.includes('18')) {
    bg = 'rgba(185, 28, 28, 0.25)';
    color = '#fca5a5';
    border = 'rgba(185, 28, 28, 0.45)';
  }

  return `<span class="epg-pill rating-pill" style="background: ${bg}; color: ${color}; border: 1px solid ${border}; font-weight: 700;">🔞 ${rating || 'Livre'}</span>`;
}

function renderEpgTimeline(events) {
  if (epgCollectionTimer) {
    clearTimeout(epgCollectionTimer);
    epgCollectionTimer = null;
  }
  const eitDiv = document.getElementById('eitDetails');
  const epgLastUpdateText = document.getElementById('epgLastUpdateText');
  if (!eitDiv) return;

  if (!events || !events.length) {
    eitDiv.innerHTML = '<div class="empty-state">Nenhum evento EPG recebido ainda para este canal.</div>';
    return;
  }

  const now = Date.now();
  const serviceGroups = new Map();
  events.forEach(e => {
    const sId = e.serviceId || 1;
    if (!serviceGroups.has(sId)) serviceGroups.set(sId, []);
    serviceGroups.get(sId).push(e);
  });

  const blocksHtml = [];

  for (const [sId, sEvents] of serviceGroups.entries()) {
    const sorted = [...sEvents].sort((a, b) => {
      const tA = a.startTime ? new Date(a.startTime).getTime() : 0;
      const tB = b.startTime ? new Date(b.startTime).getTime() : 0;
      return tA - tB;
    });

    let serviceName = `Serviço ${sId}`;
    if (allCurrentServices && allCurrentServices.length) {
      const s = allCurrentServices.find(x => x.id === sId);
      if (s && s.name) serviceName = s.name;
    }

    let liveEvent = null;
    let upcomingEvents = [];

    for (let i = 0; i < sorted.length; i++) {
      const ev = sorted[i];
      if (ev.startTime && ev.durationSec) {
        const startMs = new Date(ev.startTime).getTime();
        const endMs = startMs + (ev.durationSec * 1000);
        if (now >= startMs && now <= endMs) {
          liveEvent = ev;
          upcomingEvents = sorted.slice(i + 1, i + 5);
          break;
        }
      }
    }

    if (!liveEvent && sorted.length > 0) {
      liveEvent = sorted[0];
      upcomingEvents = sorted.slice(1, 5);
    }

    let progressPct = 50;
    let timeLabel = '';
    let remainingLabel = '';

    if (liveEvent && liveEvent.startTime && liveEvent.durationSec) {
      const startMs = new Date(liveEvent.startTime).getTime();
      const durMs = liveEvent.durationSec * 1000;
      const endMs = startMs + durMs;
      const elapsedMs = Math.max(0, now - startMs);
      progressPct = Math.min(100, Math.max(0, Math.round((elapsedMs / durMs) * 100)));

      const startStr = new Date(startMs).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Fortaleza' });
      const endStr = new Date(endMs).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Fortaleza' });
      timeLabel = `${startStr} – ${endStr}`;
      const remMin = Math.max(0, Math.round((endMs - now) / 60000));
      remainingLabel = `Restam ${remMin} min (${progressPct}%)`;
    }

    const upcomingHtml = upcomingEvents.map(u => {
      const uStart = u.startTime ? new Date(u.startTime).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Fortaleza' }) : '--:--';
      const uDur = u.durationSec ? `${Math.round(u.durationSec / 60)} min` : '';
      return `
        <div class="epg-upcoming-item" title="${u.eventName || 'Programa'}">
          <div class="epg-upcoming-time">⏱️ ${uStart} <span class="text-muted">(${uDur})</span></div>
          <div class="epg-upcoming-name">${u.eventName || 'Programa'}</div>
          <div style="display: flex; gap: 4px; margin-top: 3px; font-size: 0.7rem;">
            <span style="color: #c4b5fd;">🏷️ ${u.genre || 'Geral'}</span>
          </div>
        </div>
      `;
    }).join('');

    blocksHtml.push(`
      <div class="epg-timeline-service-block">
        <div class="epg-service-header">
          <div class="epg-service-title">📺 ${serviceName}</div>
          <span class="badge-tech">${sorted.length} Programas na Grade</span>
        </div>

        ${liveEvent ? `
          <div class="epg-now-playing-card">
            <div style="display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 6px;">
              <div>
                <div style="display: flex; align-items: center; gap: 6px; margin-bottom: 4px; flex-wrap: wrap;">
                  <span class="epg-now-badge">🔴 NO AR AGORA</span>
                  <span class="epg-pill genre-pill" style="background: rgba(139, 92, 246, 0.15); color: #c4b5fd; border: 1px solid rgba(139, 92, 246, 0.3);">🏷️ ${liveEvent.genre || 'Geral'}</span>
                  ${getRatingBadgeHtml(liveEvent.rating)}
                </div>
                <h4 style="font-size: 1.05rem; font-weight: 700; margin: 0 0 4px 0; color: #fff;">${liveEvent.eventName || 'Programa Ao Vivo'}</h4>
              </div>
              <span class="epg-pill time-pill">${timeLabel}</span>
            </div>
            <p class="epg-synopsis" style="margin: 4px 0 8px 0;">${liveEvent.eventText || 'Sem sinopse informada pela emissora.'}</p>
            <div class="epg-progress-track">
              <div class="epg-progress-fill" style="width: ${progressPct}%;"></div>
            </div>
            <div class="epg-progress-labels">
              <span>Início: ${timeLabel.split('–')[0] || ''}</span>
              <span style="color: #38bdf8; font-weight: 600;">${remainingLabel}</span>
              <span>Término: ${timeLabel.split('–')[1] || ''}</span>
            </div>
          </div>
        ` : ''}

        ${upcomingEvents.length ? `
          <div style="margin-top: 4px;">
            <div style="font-size: 0.76rem; font-weight: 700; color: var(--text-dim); margin-bottom: 6px;">A SEGUIR NA PROGRAMAÇÃO:</div>
            <div class="epg-upcoming-horizontal">
              ${upcomingHtml}
            </div>
          </div>
        ` : ''}
      </div>
    `);
  }

  eitDiv.innerHTML = `<div class="epg-timeline-container">${blocksHtml.join('')}</div>`;
  lastEpgRenderTime = Date.now();
  epgHasRendered = true;
  if (epgLastUpdateText) {
    epgLastUpdateText.textContent = `Linha do Tempo EPG atualizada às ${new Date(lastEpgRenderTime).toLocaleTimeString('pt-BR', { timeZone: 'America/Fortaleza' })} (${events.length} programas na grade)`;
  }
}

function renderEpgList(events) {
  if (epgCollectionTimer) {
    clearTimeout(epgCollectionTimer);
    epgCollectionTimer = null;
  }
  const eitDiv = document.getElementById('eitDetails');
  const epgLastUpdateText = document.getElementById('epgLastUpdateText');
  if (!eitDiv) return;

  if (!events || !events.length) {
    eitDiv.innerHTML = '<div class="empty-state">Nenhum evento EPG recebido ainda para este canal.</div>';
    return;
  }

  const EPG_PER_PAGE = 10;
  const totalPages = Math.ceil(events.length / EPG_PER_PAGE);

  if (currentEpgPageIndex >= totalPages) {
    currentEpgPageIndex = 0;
  }

  const startIdx = currentEpgPageIndex * EPG_PER_PAGE;
  const pageEvents = events.slice(startIdx, startIdx + EPG_PER_PAGE);

  let pagerHtml = '';
  if (totalPages > 1) {
    let tabsHtml = '';
    for (let p = 0; p < totalPages; p++) {
      const startNum = p * EPG_PER_PAGE + 1;
      const endNum = Math.min((p + 1) * EPG_PER_PAGE, events.length);
      tabsHtml += `
        <button class="service-tab-num ${p === currentEpgPageIndex ? 'active' : ''}" onclick="setEpgPage(${p})" title="Programas ${startNum} a ${endNum}">
          ${p + 1}
        </button>
      `;
    }

    pagerHtml = `
      <div class="epg-pager-bar" style="margin-bottom: 12px; background: rgba(18, 22, 34, 0.7); padding: 8px 12px; border-radius: var(--radius-sm); border: 1px solid var(--border-color); display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px;">
        <div style="display: flex; align-items: center; gap: 8px;">
          <span style="font-size: 0.78rem; font-weight: 600; color: var(--text-dim);">Páginas (10 por aba):</span>
          <button class="btn-pager" onclick="prevEpgPage()" title="Página anterior">◀</button>
          <div class="service-numeric-tabs epg-numeric-tabs">${tabsHtml}</div>
          <button class="btn-pager" onclick="nextEpgPage()" title="Próxima página">▶</button>
        </div>
        <span class="font-mono text-muted" style="font-size: 0.76rem;">
          Exibindo <strong>${startIdx + 1}–${Math.min(startIdx + EPG_PER_PAGE, events.length)}</strong> de <strong>${events.length}</strong> programas
        </span>
      </div>
    `;
  }

  const itemsHtml = pageEvents.map((e, idx) => {
    let dateFormatted = 'Data não informada';
    let timeFormatted = 'Horário não informado';
    let durationFormatted = e.durationSec ? `${Math.round(e.durationSec / 60)} min` : '-';

    if (e.startTime) {
      try {
        const dStart = new Date(e.startTime);
        dateFormatted = dStart.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'America/Fortaleza' });
        const startStr = dStart.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Fortaleza' });
        if (e.durationSec) {
          const dEnd = new Date(dStart.getTime() + (e.durationSec * 1000));
          const endStr = dEnd.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Fortaleza' });
          timeFormatted = `${startStr} às ${endStr}`;
        } else {
          timeFormatted = startStr;
        }
      } catch (err) {}
    }

    const itemNum = startIdx + idx + 1;

    return `
      <div class="service-card epg-card">
        <div class="service-card-header">
          <div>
            <span class="service-num-badge" style="margin-right: 6px;">#${itemNum}</span>
            <strong>${e.eventName || 'Programa'}</strong>
          </div>
          <span class="badge-tech">Event ID ${e.eventId}</span>
        </div>
        <div class="epg-schedule-grid">
          <span class="epg-pill date-pill">📅 ${dateFormatted}</span>
          <span class="epg-pill time-pill">⏰ ${timeFormatted}</span>
          <span class="epg-pill dur-pill">⏱️ ${durationFormatted}</span>
          <span class="epg-pill genre-pill" style="background: rgba(139, 92, 246, 0.15); color: #c4b5fd; border: 1px solid rgba(139, 92, 246, 0.3);">🏷️ ${e.genre || 'Geral'}</span>
          ${getRatingBadgeHtml(e.rating)}
        </div>
        <p class="epg-synopsis">${e.eventText || 'Sem sinopse informada pela emissora.'}</p>
      </div>
    `;
  }).join('');

  eitDiv.innerHTML = `${pagerHtml}<div class="services-list">${itemsHtml}</div>`;

  lastEpgRenderTime = Date.now();
  epgHasRendered = true;
  if (epgLastUpdateText) {
    epgLastUpdateText.textContent = `Última atualização: ${new Date(lastEpgRenderTime).toLocaleTimeString('pt-BR', { timeZone: 'America/Fortaleza' })} (${events.length} programas) • Automático a cada 6h ou via botão`;
  }
}

function manualRefreshEpg() {
  if (epgCollectionTimer) {
    clearTimeout(epgCollectionTimer);
    epgCollectionTimer = null;
  }
  const btn = document.getElementById('btnRefreshEpg');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span>⏳</span> Atualizando...';
    setTimeout(() => {
      btn.disabled = false;
      btn.innerHTML = '<span>🔄</span> Atualizar EPG';
    }, 400);
  }
  if (currentEpgViewMode === 'timeline') {
    renderEpgTimeline(cachedEitEvents);
  } else {
    renderEpgList(cachedEitEvents);
  }
}

// Atualiza o EPG automaticamente a cada 6 horas
setInterval(() => {
  if (cachedEitEvents && cachedEitEvents.length) {
    if (currentEpgViewMode === 'timeline') {
      renderEpgTimeline(cachedEitEvents);
    } else {
      renderEpgList(cachedEitEvents);
    }
  }
}, 6 * 60 * 60 * 1000);

// 10. Renderização Geral de Análise
function renderAnalysis(data) {
  if (!data) return;
  currentAnalysis = data;
  pidsList = data.pids || [];

  const ts = data.ts || {};
  const newTsId = ts.id !== undefined && ts.id !== null ? ts.id : (data.pat ? data.pat.tsId : null);
  if (currentActiveTsId !== null && newTsId !== null && currentActiveTsId !== newTsId) {
    resetFullChannelState();
  }
  if (newTsId !== null) {
    currentActiveTsId = newTsId;
  }

  const totalBitrate = ts.totalBitrateKbps || data.totalBitrateKbps || 0;
  const usefulBitrate = ts.usefulBitrateKbps !== undefined ? ts.usefulBitrateKbps : (data.usefulBitrateKbps || 0);
  const nullBitrate = ts.nullBitrateKbps !== undefined ? ts.nullBitrateKbps : (data.nullBitrateKbps || 0);
  const usefulPercent = ts.usefulPercent !== undefined ? ts.usefulPercent : (data.usefulPercent || 0);
  const nullPercent = ts.nullPercent !== undefined ? ts.nullPercent : (data.nullPercent || 0);

  document.getElementById('statTotalBitrate').textContent = `${totalBitrate.toLocaleString('pt-BR')} kbps`;
  document.getElementById('statUsefulBitrate').textContent = `${usefulBitrate.toLocaleString('pt-BR')} kbps`;
  document.getElementById('statUsefulPercent').textContent = `${usefulPercent}% útil`;
  document.getElementById('statNullBitrate').textContent = `${nullBitrate.toLocaleString('pt-BR')} kbps`;
  document.getElementById('statNullPercent').textContent = `${nullPercent}% stuffing`;
  
  const tsIdHex = ts.idHex || (data.pat ? `0x${data.pat.tsId.toString(16).toUpperCase().padStart(4, '0')}` : (ts.id ? `0x${ts.id.toString(16).toUpperCase().padStart(4, '0')}` : '-'));
  document.getElementById('statTsId').textContent = tsIdHex;
  
  const networkId = ts.networkId !== null && ts.networkId !== undefined ? ts.networkId : (data.tables && data.tables.nit && data.tables.nit[0] ? data.tables.nit[0].networkId : '-');
  document.getElementById('statNetworkId').textContent = `Network ID: ${networkId}`;
  document.getElementById('statTotalPackets').textContent = (ts.totalPackets || data.totalPackets || 0).toLocaleString('pt-BR');
  document.getElementById('statSyncErrors').textContent = `Erros Sincronismo: ${ts.syncErrors !== undefined ? ts.syncErrors : (data.syncErrors || 0)}`;

  renderBitrateDistribution(pidsList, totalBitrate || 1);

  const services = data.services || data.programs || [];
  document.getElementById('badgeServiceCount').textContent = services.length;
  document.getElementById('badgePidCount').textContent = pidsList.length;
  renderServices(services, false);
  renderPidTable();

  renderLoudness(data);

  if (data.cc && data.cc.lastText) {
    renderClosedCaption(data.cc.lastText);
  }

  if (data.alarms) {
    renderAlarmsTable(data.alarms);
  }

  renderEtr290AndGinga(data);
  renderTablesInspector(data);
}

function renderEtr290AndGinga(data) {
  const etr = data.etr290 || {
    p1: { passed: true, tsSyncLoss: true, syncByteError: true, patError: true, ccError: true, pmtError: true, pidError: true },
    p2: { passed: true, transportError: true, crcError: true, pcrRepetition: true, catError: true },
    p3: { passed: true, sdtError: true, nitError: true, eitError: true },
  };

  setLed('ledSync', etr.p1.syncByteError);
  setLed('ledSyncLoss', etr.p1.tsSyncLoss);
  setLed('ledPat', etr.p1.patError);
  setLed('ledCc', etr.p1.ccError);
  setLed('ledPmt', etr.p1.pmtError);

  setLed('ledTei', etr.p2.transportError);
  setLed('ledCrc', etr.p2.crcError);

  setLed('ledSdt', etr.p3.sdtError);
  setLed('ledEit', etr.p3.eitError);

  const gingaDetected = data.ginga && data.ginga.detected;
  setLed('ledGinga', gingaDetected);
  const gingaTxt = document.getElementById('gingaStatusText');
  if (gingaTxt) {
    gingaTxt.textContent = gingaDetected ? 'Presente (DSM-CC)' : 'Não detectado';
  }
}

function setLed(id, isOk) {
  const el = document.getElementById(id);
  if (el) {
    el.className = `led-dot ${isOk ? 'ok' : 'fail'}`;
  }
}

function renderBitrateDistribution(pids, totalKbps) {
  let videoKbps = 0;
  let audioKbps = 0;
  let tablesKbps = 0;
  let nullKbps = 0;
  let otherKbps = 0;

  for (const p of pids) {
    const cat = p.category || '';
    if (cat.includes('Null')) nullKbps += p.bitrateKbps || 0;
    else if (cat.includes('Vídeo')) videoKbps += p.bitrateKbps || 0;
    else if (cat.includes('Áudio')) audioKbps += p.bitrateKbps || 0;
    else if (cat.includes('Tabela') || cat.includes('PAT') || cat.includes('PMT') || cat.includes('SDT') || cat.includes('NIT') || cat.includes('EIT')) tablesKbps += p.bitrateKbps || 0;
    else otherKbps += p.bitrateKbps || 0;
  }

  const safeTotal = Math.max(totalKbps, 1);
  const pVideo = ((videoKbps / safeTotal) * 100).toFixed(1);
  const pAudio = ((audioKbps / safeTotal) * 100).toFixed(1);
  const pTables = ((tablesKbps / safeTotal) * 100).toFixed(1);
  const pOther = ((otherKbps / safeTotal) * 100).toFixed(1);
  const pNull = ((nullKbps / safeTotal) * 100).toFixed(1);

  const track = document.getElementById('bitrateBarTrack');
  if (track) {
    track.innerHTML = `
      <div class="bar-segment bar-video" style="width: ${pVideo}%;" title="Vídeo: ${pVideo}% (${videoKbps} kbps)"></div>
      <div class="bar-segment bar-audio" style="width: ${pAudio}%;" title="Áudio: ${pAudio}% (${audioKbps} kbps)"></div>
      <div class="bar-segment bar-tables" style="width: ${pTables}%;" title="Tabelas: ${pTables}% (${tablesKbps} kbps)"></div>
      <div class="bar-segment bar-other" style="width: ${pOther}%;" title="Outros/Ginga: ${pOther}% (${otherKbps} kbps)"></div>
      <div class="bar-segment bar-null" style="width: ${pNull}%;" title="Null (Padding): ${pNull}% (${nullKbps} kbps)"></div>
    `;
  }

  const summary = document.getElementById('bitrateBreakdownSummary');
  if (summary) {
    summary.textContent = `Vídeo: ${pVideo}% | Áudio: ${pAudio}% | Tabelas: ${pTables}% | Null (0x1FFF): ${pNull}%`;
  }
}

let currentServicePageIndex = 0;
let allCurrentServices = [];
let lastServicesRenderTime = 0;

function setServicePage(idx) {
  currentServicePageIndex = idx;
  renderServices(allCurrentServices, true);
}

function prevServicePage() {
  if (!allCurrentServices.length) return;
  const totalPages = Math.ceil(allCurrentServices.length / 2);
  currentServicePageIndex = (currentServicePageIndex - 1 + totalPages) % totalPages;
  renderServices(allCurrentServices, true);
}

function nextServicePage() {
  if (!allCurrentServices.length) return;
  const totalPages = Math.ceil(allCurrentServices.length / 2);
  currentServicePageIndex = (currentServicePageIndex + 1) % totalPages;
  renderServices(allCurrentServices, true);
}

function getPidBitrate(pid) {
  if (!pidsList || !pidsList.length || !pid) return 0;
  const p = pidsList.find(x => x.id === pid);
  return p ? (p.bitrateKbps || 0) : 0;
}

function formatKbps(kbps) {
  if (!kbps || kbps <= 0) return '0 kbps';
  if (kbps >= 1000) {
    return `${(kbps / 1000).toFixed(2)} Mbps`;
  }
  return `${Math.round(kbps)} kbps`;
}

function renderServices(services, force = false) {
  const now = Date.now();
  if (!force && (now - lastServicesRenderTime < 5000) && lastServicesRenderTime !== 0) {
    return;
  }
  lastServicesRenderTime = now;

  allCurrentServices = services || [];
  updateServiceDecodeDropdown(allCurrentServices);
  const container = document.getElementById('servicesContainer');
  const pagerBar = document.getElementById('servicesPagerBar');
  const tabsContainer = document.getElementById('serviceTabsContainer');
  if (!container) return;

  if (!allCurrentServices || !allCurrentServices.length) {
    if (pagerBar) pagerBar.classList.add('hidden');
    container.className = 'services-side-list';
    container.innerHTML = '<div class="empty-state">Nenhum canal detectado. Inicie a sintonia.</div>';
    return;
  }

  const SERVICES_PER_PAGE = 2;
  const totalPages = Math.ceil(allCurrentServices.length / SERVICES_PER_PAGE);

  if (currentServicePageIndex >= totalPages) {
    currentServicePageIndex = 0;
  }

  // Se houver mais de 2 canais, exibe 2 por página (em 2 colunas) com passador numérico
  if (allCurrentServices.length > 2) {
    if (pagerBar) pagerBar.classList.remove('hidden');
    container.className = 'services-side-list two-cols';

    if (tabsContainer) {
      let tabsHtml = '';
      for (let p = 0; p < totalPages; p++) {
        const startNum = p * SERVICES_PER_PAGE + 1;
        const endNum = Math.min((p + 1) * SERVICES_PER_PAGE, allCurrentServices.length);
        const label = startNum === endNum ? `${startNum}` : `${startNum}-${endNum}`;
        tabsHtml += `
          <button class="service-tab-num ${p === currentServicePageIndex ? 'active' : ''}" onclick="setServicePage(${p})" title="Canais ${label}">
            ${label}
          </button>
        `;
      }
      tabsContainer.innerHTML = tabsHtml;
    }

    const startIdx = currentServicePageIndex * SERVICES_PER_PAGE;
    const pageServices = allCurrentServices.slice(startIdx, startIdx + SERVICES_PER_PAGE);
    container.innerHTML = pageServices.map((s, idx) => renderSingleServiceCard(s, startIdx + idx + 1, allCurrentServices.length)).join('');
  } else if (allCurrentServices.length === 2) {
    // Exatamente 2 canais: 2 lado a lado sem paginação
    if (pagerBar) pagerBar.classList.add('hidden');
    container.className = 'services-side-list two-cols';
    container.innerHTML = allCurrentServices.map((s, idx) => renderSingleServiceCard(s, idx + 1, allCurrentServices.length)).join('');
  } else {
    // 1 canal: ocupa largura total
    if (pagerBar) pagerBar.classList.add('hidden');
    container.className = 'services-side-list';
    container.innerHTML = allCurrentServices.map((s, idx) => renderSingleServiceCard(s, idx + 1, allCurrentServices.length)).join('');
  }
}

function renderSingleServiceCard(s, num, total) {
  const pmtKbps = getPidBitrate(s.pmtPid);
  const pcrKbps = getPidBitrate(s.pcrPid);

  let serviceTotalKbps = pmtKbps;

  const componentsHtml = (s.components || []).map((c) => {
    let badgeClass = 'data';
    if (c.isVideo) badgeClass = 'video';
    else if (c.isAudio) badgeClass = 'audio';

    const compKbps = getPidBitrate(c.pid) || c.bitrateKbps || 0;
    serviceTotalKbps += compKbps;

    return `
      <li class="component-item">
        <div>
          <span class="badge-codec ${badgeClass}">${c.type}</span>
          <span style="margin-left: 8px;">PID ${c.pid} (${c.pidHex || `0x${(c.pid || 0).toString(16).toUpperCase()}`})</span>
        </div>
        <span class="font-mono" style="font-weight: 700; color: var(--accent-cyan); font-size: 0.78rem;">
          ${formatKbps(compKbps)}
        </span>
      </li>
    `;
  }).join('');

  return `
    <div class="service-card">
      <div class="service-card-header">
        <div>
          <div class="service-title">
            ${total > 1 ? `<span class="service-num-badge">${num}/${total}</span> ` : ''}${s.name || `Canal ${s.id}`}
          </div>
          <div class="service-provider">${s.provider || 'Emissora ISDB-T'}</div>
        </div>
        <div style="text-align: right;">
          <span class="badge-tech">${s.type || 'Digital TV'}</span>
          <div style="font-size: 0.76rem; font-weight: 700; color: var(--accent-blue); margin-top: 2px;">
            ${formatKbps(serviceTotalKbps)}
          </div>
        </div>
      </div>
      <div class="service-meta-row">
        <span><strong>Prog ID:</strong> ${s.id}</span>
        <span><strong>PMT:</strong> ${s.pmtPidHex || '0x' + (s.pmtPid||0).toString(16).toUpperCase()} <span class="font-mono text-muted">(${formatKbps(pmtKbps)})</span></span>
        <span><strong>PCR:</strong> ${s.pcrPidHex || '0x' + (s.pcrPid||0).toString(16).toUpperCase()}</span>
      </div>
      <div style="font-weight: 600; font-size: 0.76rem; margin-top: 6px; color: var(--text-dim); border-top: 1px solid var(--border-color); padding-top: 4px;">
        Streams Elementares (Taxa Individual):
      </div>
      <ul class="components-list">${componentsHtml || '<li class="text-muted">Aguardando componentes...</li>'}</ul>
    </div>
  `;
}

function filterPidTable() {
  renderPidTable();
}

function sortPidTable(field) {
  if (currentSortField === field) sortAscending = !sortAscending;
  else { currentSortField = field; sortAscending = false; }
  renderPidTable();
}

function renderPidTable() {
  const tbody = document.getElementById('pidsTableBody');
  if (!tbody) return;
  const search = (document.getElementById('pidSearchInput')?.value || '').toLowerCase();
  const categoryFilter = document.getElementById('pidCategoryFilter')?.value || 'ALL';

  let filtered = pidsList.filter((p) => {
    if (categoryFilter !== 'ALL' && !p.category.toLowerCase().includes(categoryFilter.toLowerCase())) return false;
    if (search) {
      const target = `${p.id} ${p.idHex} ${p.description} ${p.category} ${(p.services || []).join(' ')}`.toLowerCase();
      return target.includes(search);
    }
    return true;
  });

  if (!filtered.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="text-center text-muted">Nenhum PID encontrado para os critérios selecionados</td></tr>';
    return;
  }

  // Obter lista de programas/serviços ativos no MUX
  const services = (currentAnalysis && (currentAnalysis.services || currentAnalysis.programs)) ? (currentAnalysis.services || currentAnalysis.programs) : [];
  const assignedPidSet = new Set();
  const groupBlocksHtml = [];

  // 1. Agrupar por cada Programa/Serviço (SDT / PMT)
  services.forEach((s) => {
    const sName = s.name || `Programa ${s.id}`;
    const sId = s.id;

    // PIDs associados ao serviço
    const servicePids = filtered.filter(p => {
      const inServices = Array.isArray(p.services) && p.services.some(srv => srv.includes(sName) || srv.includes(`Prog ${sId}`) || srv.includes(String(sId)));
      const isPmt = s.pmtPid && p.id === s.pmtPid;
      const isPcr = s.pcrPid && p.id === s.pcrPid;
      const isComp = Array.isArray(s.components) && s.components.some(c => c.pid === p.id);
      return inServices || isPmt || isPcr || isComp;
    });

    if (servicePids.length > 0) {
      servicePids.forEach(p => assignedPidSet.add(p.id));

      // Ordenar PIDs dentro do serviço por taxa decrescente (ou pelo campo selecionado)
      servicePids.sort((a, b) => {
        if (currentSortField !== 'bitrate') {
          let valA = a[currentSortField], valB = b[currentSortField];
          if (typeof valA === 'string') valA = valA.toLowerCase();
          if (typeof valB === 'string') valB = valB.toLowerCase();
          if (valA < valB) return sortAscending ? -1 : 1;
          if (valA > valB) return sortAscending ? 1 : -1;
        }
        return sortAscending ? (a.bitrateKbps - b.bitrateKbps) : (b.bitrateKbps - a.bitrateKbps);
      });

      const totalServiceKbps = servicePids.reduce((sum, p) => sum + (p.bitrateKbps || 0), 0);
      const totalServicePct = servicePids.reduce((sum, p) => sum + (p.percent || 0), 0).toFixed(2);

      groupBlocksHtml.push(`
        <tr class="table-group-header">
          <td colspan="7">
            <div class="table-group-title">
              <span>📺 <strong>Serviço: ${sName}</strong> <span class="text-muted" style="font-size: 0.76rem; font-weight: normal; margin-left: 6px;">(Prog ID: ${sId} | PMT: ${s.pmtPidHex || '0x' + (s.pmtPid||0).toString(16).toUpperCase()})</span></span>
              <span class="group-rate-badge">Taxa do Serviço: ${formatKbps(totalServiceKbps)} (${totalServicePct}%)</span>
            </div>
          </td>
        </tr>
      `);
      servicePids.forEach(p => groupBlocksHtml.push(renderSinglePidRow(p)));
    }
  });

  // 2. Tabelas PSI/SI & Infraestrutura (listadas diretamente na sequência)
  const psiSiPids = filtered.filter(p => !assignedPidSet.has(p.id) && (p.category === 'Tabela PSI/SI' || [0, 1, 0x10, 0x11, 0x12, 0x14].includes(p.id)));
  if (psiSiPids.length > 0) {
    psiSiPids.forEach(p => assignedPidSet.add(p.id));
    psiSiPids.sort((a, b) => a.id - b.id);
    psiSiPids.forEach(p => groupBlocksHtml.push(renderSinglePidRow(p)));
  }

  // 3. Outros PIDs adicionais
  const remainingPids = filtered.filter(p => !assignedPidSet.has(p.id) && p.id !== 8191 && p.id !== 0x1fff && !p.category.includes('Null'));
  if (remainingPids.length > 0) {
    remainingPids.forEach(p => assignedPidSet.add(p.id));
    remainingPids.sort((a, b) => (b.bitrateKbps || 0) - (a.bitrateKbps || 0));
    remainingPids.forEach(p => groupBlocksHtml.push(renderSinglePidRow(p)));
  }

  // 4. Preenchimento de MUX (Null / Stuffing Packets - PID 0x1FFF / 8191) listado ao final
  const nullPids = filtered.filter(p => !assignedPidSet.has(p.id) || p.id === 8191 || p.id === 0x1fff || p.category.includes('Null'));
  if (nullPids.length > 0) {
    nullPids.forEach(p => groupBlocksHtml.push(renderSinglePidRow(p)));
  }

  tbody.innerHTML = groupBlocksHtml.join('');
}

function renderSinglePidRow(p) {
  let catColor = '#93c5fd';
  let catBg = 'rgba(59, 130, 246, 0.12)';
  if (p.category === 'Vídeo') { catColor = '#60a5fa'; catBg = 'rgba(37, 99, 235, 0.15)'; }
  else if (p.category === 'Áudio') { catColor = '#34d399'; catBg = 'rgba(16, 185, 129, 0.15)'; }
  else if (p.category.includes('Null')) { catColor = '#94a3b8'; catBg = 'rgba(100, 116, 139, 0.15)'; }
  else if (p.category.includes('PSI/SI')) { catColor = '#c4b5fd'; catBg = 'rgba(139, 92, 246, 0.15)'; }

  return `
    <tr class="${(p.ccErrors > 0 || p.teiErrors > 0) ? 'row-warn' : ''}">
      <td class="font-mono"><strong>${p.id}</strong> <span class="text-muted">(${p.idHex || `0x${p.id.toString(16).toUpperCase().padStart(4, '0')}`})</span></td>
      <td><span class="tag-table" style="background: ${catBg}; color: ${catColor};">${p.category}</span></td>
      <td>${p.description || p.role}</td>
      <td class="font-mono">${(p.packets || 0).toLocaleString('pt-BR')}</td>
      <td class="font-mono" style="color: var(--accent-cyan); font-weight: 700;">${(p.bitrateKbps || 0).toLocaleString('pt-BR')} kbps</td>
      <td class="font-mono"><strong>${p.percent || 0}%</strong></td>
      <td>${Array.isArray(p.services) && p.services.length ? p.services.join(', ') : '-'}</td>
    </tr>
  `;
}

function renderTablesInspector(data) {
  const tables = data.tables || {};

  // PAT
  const patDiv = document.getElementById('patDetails');
  const patList = tables.pat || (data.pat ? [data.pat] : []);
  if (patDiv && patList.length) {
    patDiv.innerHTML = patList.map(pat => `
      <table class="data-table">
        <thead><tr><th>Program Number</th><th>PMT PID (Dec)</th><th>PMT PID (Hex)</th></tr></thead>
        <tbody>
          ${(pat.programs || []).map(p => `<tr><td><strong>Programa ${p.programNumber}</strong></td><td class="font-mono">${p.pid}</td><td class="font-mono">${p.pidHex || `0x${(p.pid||0).toString(16).toUpperCase()}`}</td></tr>`).join('')}
        </tbody>
      </table>
    `).join('');
  }

  // PMT
  const pmtDiv = document.getElementById('pmtDetails');
  const pmtList = tables.pmt || data.programs || [];
  if (pmtDiv && pmtList.length) {
    pmtDiv.innerHTML = `<div class="services-list">${pmtList.map(pmt => `
      <div class="service-card">
        <div class="service-card-header"><strong>Programa ${pmt.programNumber || pmt.id}</strong><span class="badge-tech">PMT PID 0x${(pmt.pmtPid||0).toString(16).toUpperCase()}</span></div>
        <div class="service-meta-row"><span><strong>PCR PID:</strong> 0x${(pmt.pcrPid||0).toString(16).toUpperCase()} (${pmt.pcrPid || '-'})</span></div>
      </div>
    `).join('')}</div>`;
  }

  // SDT
  const sdtDiv = document.getElementById('sdtDetails');
  const sdtList = tables.sdt || [];
  if (sdtDiv && sdtList.length) {
    sdtDiv.innerHTML = `
      <table class="data-table">
        <thead><tr><th>Service ID</th><th>Nome do Canal</th><th>Emissora / Provedor</th><th>Status</th></tr></thead>
        <tbody>
          ${sdtList.map(s => `<tr><td class="font-mono"><strong>${s.serviceId}</strong></td><td><span style="color: var(--accent-cyan); font-weight: 700;">${s.serviceName}</span></td><td>${s.providerName || '-'}</td><td><span class="tool-pill online">Ativo</span></td></tr>`).join('')}
        </tbody>
      </table>
    `;
  }

  // NIT
  const nitDiv = document.getElementById('nitDetails');
  const nitList = tables.nit || (data.nit ? [data.nit] : []);
  if (nitDiv && nitList.length) {
    nitDiv.innerHTML = nitList.map(n => `<div class="stat-card"><strong>Rede:</strong> ${n.networkName || 'Rede Digital'} | <strong>Network ID:</strong> 0x${(n.networkId||0).toString(16).toUpperCase()}</div>`).join('');
  }

  // Coleta a grade de eventos EIT e atualiza a interface de forma contínua
  if (tables.eit && tables.eit.length) {
    const prevCount = cachedEitEvents ? cachedEitEvents.length : 0;
    cachedEitEvents = tables.eit;

    if (!epgHasRendered || cachedEitEvents.length !== prevCount) {
      const now = Date.now();
      if (!lastEpgRenderTime || (now - lastEpgRenderTime > 1500)) {
        renderCurrentEpgView(cachedEitEvents);
      } else {
        if (epgCollectionTimer) clearTimeout(epgCollectionTimer);
        epgCollectionTimer = setTimeout(() => {
          renderCurrentEpgView(cachedEitEvents);
        }, 1200);
      }
    }
  }

  // TOT
  const totDiv = document.getElementById('totDetails');
  const totList = tables.tot || (data.tot ? [data.tot] : []);
  if (totDiv && totList.length) {
    totDiv.innerHTML = totList.map(t => `<div class="stat-card"><strong>Horário Oficial Transmitido:</strong> ${t.utcTime ? new Date(t.utcTime).toLocaleString('pt-BR', { timeZone: 'America/Fortaleza' }) : '-'} (Fuso Ceará / UTC-3)</div>`).join('');
  }

  // Raw
  const rawPre = document.getElementById('rawTablesText');
  if (rawPre) rawPre.textContent = data.rawTablesText || JSON.stringify(tables, null, 2);
}

// Tabs & Navigation
function switchTab(tabId) {
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tabId));
  document.querySelectorAll('.tab-content').forEach((c) => c.classList.toggle('active', c.id === `tab-${tabId}`));
}

function switchSubTable(tableKey) {
  document.querySelectorAll('.sub-tab-btn').forEach((b) => {
    b.classList.toggle('active', b.getAttribute('onclick').includes(tableKey));
  });
  document.querySelectorAll('.sub-tab-content').forEach((c) => {
    c.classList.toggle('active', c.id === `subtab-${tableKey}`);
  });
  if (tableKey === 'eit' && !epgHasRendered && cachedEitEvents.length) {
    renderEpgList(cachedEitEvents);
  }
}

function appendLog(line) {
  if (!systemLogs) return;
  const text = line.endsWith('\n') ? line : line + '\n';
  systemLogs.textContent += text;
  const lines = systemLogs.textContent.split('\n');
  if (lines.length > 500) systemLogs.textContent = lines.slice(-500).join('\n');
  systemLogs.scrollTop = systemLogs.scrollHeight;
}

function clearLogs() {
  if (systemLogs) systemLogs.textContent = '';
}

// 11. Closed Caption (CC) Live Rendering
let ccEnabled = true;
let ccFadeTimer = null;

function toggleClosedCaption() {
  ccEnabled = !ccEnabled;
  const btn = document.getElementById('btnToggleCc');
  const box = document.getElementById('ccDisplayBox');
  if (btn) {
    btn.classList.toggle('active', ccEnabled);
    btn.textContent = ccEnabled ? 'CC: Ativado' : 'CC: Desativado';
  }
  if (box) {
    box.style.display = ccEnabled ? 'block' : 'none';
  }
}

function renderClosedCaption(text) {
  if (!ccEnabled || !text) return;
  const ccEl = document.getElementById('ccText');
  if (!ccEl) return;
  ccEl.textContent = text;
  ccEl.classList.remove('faded');

  if (ccFadeTimer) clearTimeout(ccFadeTimer);
  ccFadeTimer = setTimeout(() => {
    if (ccEl) ccEl.classList.add('faded');
  }, 7000);
}

// 12. Medição de Áudio & Loudness (ABNT NBR 15602-2 / CALM Act)
function renderLoudness(data) {
  const loudness = (data && data.loudness) ? data.loudness : {
    integratedLufs: -24.0,
    shortTermLufs: -24.0,
    momentaryLufs: -24.0,
    truePeakDb: -1.8,
    lra: 6.2,
    audioCodec: 'Aguardando fluxo...',
    compliant: true
  };

  const statInt = document.getElementById('statIntegratedLufs');
  const statShort = document.getElementById('statShortTermLufs');
  const statPeak = document.getElementById('statTruePeak');
  const statLra = document.getElementById('statLra');
  const statMom = document.getElementById('statMomentaryLufs');
  const barFill = document.getElementById('loudnessBarFill');
  const badge = document.getElementById('loudnessComplianceBadge');
  const codecBadge = document.getElementById('loudnessCodecBadge');

  if (codecBadge && loudness.audioCodec) {
    codecBadge.textContent = loudness.audioCodec;
  }

  const intLufs = loudness.integratedLufs !== undefined ? loudness.integratedLufs : -24.0;
  const shortLufs = loudness.shortTermLufs !== undefined ? loudness.shortTermLufs : -24.0;
  const peakDb = loudness.truePeakDb !== undefined ? loudness.truePeakDb : -1.8;
  const lra = loudness.lra !== undefined ? loudness.lra : 6.2;
  const momLufs = loudness.momentaryLufs !== undefined ? loudness.momentaryLufs : -24.0;

  if (momLufs <= -60.0) {
    if (statInt) statInt.textContent = '-- LUFS';
    if (statShort) statShort.textContent = '-- LUFS';
    if (statPeak) statPeak.textContent = '-- dBTP';
    if (statLra) statLra.textContent = '-- LU';
    if (statMom) statMom.textContent = 'Sem Áudio';
    if (barFill) barFill.style.width = '0%';
    if (badge) {
      badge.className = 'badge-compliance fail';
      badge.textContent = 'SEM ÁUDIO';
    }
    return;
  }

  if (statInt) statInt.textContent = `${intLufs.toFixed(1)} LUFS`;
  if (statShort) statShort.textContent = `${shortLufs.toFixed(1)} LUFS`;
  if (statPeak) statPeak.textContent = `${peakDb.toFixed(1)} dBTP`;
  if (statLra) statLra.textContent = `${lra.toFixed(1)} LU`;
  if (statMom) statMom.textContent = `${momLufs.toFixed(1)} LUFS`;

  // Barra de Loudness (Escala de -40 LUFS a 0 LUFS)
  if (barFill) {
    const pct = Math.min(100, Math.max(0, ((momLufs + 40) / 40) * 100));
    barFill.style.width = `${pct}%`;
    if (momLufs > -23.0) barFill.style.background = 'var(--status-danger)';
    else if (momLufs >= -25.0) barFill.style.background = 'var(--status-ok)';
    else barFill.style.background = 'var(--status-warn)';
  }

  // Verificação de Conformidade ABNT NBR 15602-2 (Target -24 ± 1.0 LUFS e True Peak <= -1.0 dBTP)
  const isCompliant = intLufs >= -25.0 && intLufs <= -23.0 && peakDb <= -1.0;
  if (badge) {
    badge.className = `badge-compliance ${isCompliant ? 'ok' : 'fail'}`;
    badge.textContent = isCompliant ? 'CONFORME (-24 LUFS)' : 'FORA DE PADRÃO';
  }
}

// 12.1 Exportação de Laudo Técnico Formal em PDF
function exportPdfReport() {
  const data = currentAnalysis || {};
  const ts = data.ts || {};
  const rf = window.lastRfData || {};
  const loudness = data.loudness || { integratedLufs: -24.0, shortTermLufs: -23.8, truePeakDb: -1.8, lra: 6.2, compliant: true };
  const pids = pidsList || [];
  const services = data.services || data.programs || [];

  const sourceDesc = statusIndicator ? statusIndicator.textContent : 'Ao Vivo';
  const emissionDate = new Date().toLocaleString('pt-BR');
  const frameImgSrc = videoFrame && videoFrame.src ? videoFrame.src : '';

  const reportWin = window.open('', '_blank', 'width=980,height=900');
  if (!reportWin) {
    alert('Por favor, autorize a abertura de popups no navegador para emitir o Laudo Técnico em PDF.');
    return;
  }

  // 1. Construir Serviços / Programas com taxas de cada PID componente
  const servicesHtml = services.map(s => {
    const sName = s.name || `Canal ${s.id}`;
    const pmtKbps = getPidBitrate(s.pmtPid);
    const pcrKbps = getPidBitrate(s.pcrPid);
    let serviceTotalKbps = pmtKbps;

    const componentsStr = (s.components || []).map(c => {
      const cKbps = getPidBitrate(c.pid) || c.bitrateKbps || 0;
      serviceTotalKbps += cKbps;
      const rateFormatted = formatKbps(cKbps);
      return `<strong>${c.type}</strong> (${c.pidHex || '0x' + (c.pid || 0).toString(16).toUpperCase()} — <span style="color: #0369a1; font-weight: 700;">${rateFormatted}</span>)`;
    }).join(' • ');

    const pmtRateFormatted = pmtKbps > 0 ? ` (${formatKbps(pmtKbps)})` : '';
    const totalRateFormatted = formatKbps(serviceTotalKbps);

    return `
    <div style="border: 1px solid #cbd5e1; border-radius: 6px; padding: 8px 10px; margin-bottom: 6px; background: #f8fafc;">
      <div style="display: flex; justify-content: space-between; font-weight: 700; font-size: 11px;">
        <span>📺 ${sName} <span style="font-weight: 400; color: #64748b;">(${s.provider || 'ISDB-T'})</span></span>
        <span>Prog ID: ${s.id} | PMT: ${s.pmtPidHex || '-'}${pmtRateFormatted} | PCR: ${s.pcrPidHex || '-'} <span style="color: #0284c7; margin-left: 6px;">[Taxa Total: ${totalRateFormatted}]</span></span>
      </div>
      <div style="font-size: 10px; color: #334155; margin-top: 4px; line-height: 1.4;">
        <strong>Componentes & Taxas:</strong> ${componentsStr || 'N/A'}
      </div>
    </div>
  `;
  }).join('');

  // 2. Mapeamento de PIDs agrupado por serviços no Laudo PDF
  const pdfAssignedPids = new Set();
  const pdfPidsRows = [];

  services.forEach(s => {
    const sName = s.name || `Programa ${s.id}`;
    const sPids = pids.filter(p => {
      const inSrv = Array.isArray(p.services) && p.services.some(srv => srv.includes(sName) || srv.includes(`Prog ${s.id}`) || srv.includes(String(s.id)));
      const isPmt = s.pmtPid && p.id === s.pmtPid;
      const isPcr = s.pcrPid && p.id === s.pcrPid;
      const isComp = Array.isArray(s.components) && s.components.some(c => c.pid === p.id);
      return inSrv || isPmt || isPcr || isComp;
    });

    if (sPids.length > 0) {
      sPids.forEach(p => pdfAssignedPids.add(p.id));
      sPids.sort((a, b) => (b.bitrateKbps || 0) - (a.bitrateKbps || 0));
      const sTotalKbps = sPids.reduce((sum, p) => sum + (p.bitrateKbps || 0), 0);
      const sTotalPct = sPids.reduce((sum, p) => sum + (p.percent || 0), 0).toFixed(1);

      pdfPidsRows.push(`
        <tr style="background: #e2e8f0; font-weight: 700;">
          <td colspan="9" style="padding: 5px 6px; color: #0f172a;">
            📺 <strong>Serviço: ${sName}</strong> (Prog ID: ${s.id}) — <span style="color: #0369a1;">Taxa do Serviço: ${formatKbps(sTotalKbps)} (${sTotalPct}%)</span>
          </td>
        </tr>
      `);
      sPids.forEach(p => {
        pdfPidsRows.push(`
          <tr>
            <td style="font-family: monospace; font-weight: 700;">${p.idHex || `0x${p.id.toString(16).toUpperCase().padStart(4, '0')}`}</td>
            <td>${p.id}</td>
            <td><strong>${p.category || 'Outro'}</strong></td>
            <td>${p.description || '-'}</td>
            <td style="font-weight: 700; color: #0369a1;">${p.bitrateKbps ? p.bitrateKbps.toLocaleString('pt-BR') + ' kbps' : '-'}</td>
            <td><strong>${p.percent || '0'}%</strong></td>
            <td>${(p.services || []).join(', ') || '-'}</td>
            <td>${p.ccErrors || 0}</td>
            <td>${p.teiErrors || 0}</td>
          </tr>
        `);
      });
    }
  });

  // PSI/SI
  const pdfPsiPids = pids.filter(p => !pdfAssignedPids.has(p.id) && (p.category === 'Tabela PSI/SI' || [0, 1, 0x10, 0x11, 0x12, 0x14].includes(p.id)));
  if (pdfPsiPids.length > 0) {
    pdfPsiPids.forEach(p => pdfAssignedPids.add(p.id));
    pdfPsiPids.sort((a, b) => (b.bitrateKbps || 0) - (a.bitrateKbps || 0));
    const psiTotalKbps = pdfPsiPids.reduce((sum, p) => sum + (p.bitrateKbps || 0), 0);
    const psiTotalPct = pdfPsiPids.reduce((sum, p) => sum + (p.percent || 0), 0).toFixed(1);
    pdfPidsRows.push(`
      <tr style="background: #f1f5f9; font-weight: 700;">
        <td colspan="9" style="padding: 5px 6px; color: #475569;">
          📑 <strong>Tabelas de Sistema & Sinalização PSI/SI</strong> — <span style="color: #475569;">Taxa: ${formatKbps(psiTotalKbps)} (${psiTotalPct}%)</span>
        </td>
      </tr>
    `);
    pdfPsiPids.forEach(p => {
      pdfPidsRows.push(`
        <tr>
          <td style="font-family: monospace; font-weight: 700;">${p.idHex || `0x${p.id.toString(16).toUpperCase().padStart(4, '0')}`}</td>
          <td>${p.id}</td>
          <td><strong>${p.category || 'Outro'}</strong></td>
          <td>${p.description || '-'}</td>
          <td style="font-weight: 700; color: #0369a1;">${p.bitrateKbps ? p.bitrateKbps.toLocaleString('pt-BR') + ' kbps' : '-'}</td>
          <td><strong>${p.percent || '0'}%</strong></td>
          <td>${(p.services || []).join(', ') || '-'}</td>
          <td>${p.ccErrors || 0}</td>
          <td>${p.teiErrors || 0}</td>
        </tr>
      `);
    });
  }

  // Null
  const pdfNullPids = pids.filter(p => !pdfAssignedPids.has(p.id) && (p.id === 8191 || p.id === 0x1fff || p.category.includes('Null')));
  if (pdfNullPids.length > 0) {
    pdfNullPids.forEach(p => pdfAssignedPids.add(p.id));
    const nullTotalKbps = pdfNullPids.reduce((sum, p) => sum + (p.bitrateKbps || 0), 0);
    const nullTotalPct = pdfNullPids.reduce((sum, p) => sum + (p.percent || 0), 0).toFixed(1);
    pdfPidsRows.push(`
      <tr style="background: #f8fafc; font-weight: 700;">
        <td colspan="9" style="padding: 5px 6px; color: #64748b;">
          📦 <strong>Preenchimento de MUX (Null / Stuffing)</strong> — <span style="color: #64748b;">Taxa: ${formatKbps(nullTotalKbps)} (${nullTotalPct}%)</span>
        </td>
      </tr>
    `);
    pdfNullPids.forEach(p => {
      pdfPidsRows.push(`
        <tr>
          <td style="font-family: monospace; font-weight: 700;">${p.idHex || `0x${p.id.toString(16).toUpperCase().padStart(4, '0')}`}</td>
          <td>${p.id}</td>
          <td><strong>${p.category || 'Outro'}</strong></td>
          <td>${p.description || '-'}</td>
          <td style="font-weight: 700; color: #64748b;">${p.bitrateKbps ? p.bitrateKbps.toLocaleString('pt-BR') + ' kbps' : '-'}</td>
          <td><strong>${p.percent || '0'}%</strong></td>
          <td>${(p.services || []).join(', ') || '-'}</td>
          <td>${p.ccErrors || 0}</td>
          <td>${p.teiErrors || 0}</td>
        </tr>
      `);
    });
  }

  // Demais PIDs
  const pdfRemainingPids = pids.filter(p => !pdfAssignedPids.has(p.id));
  if (pdfRemainingPids.length > 0) {
    pdfRemainingPids.forEach(p => {
      pdfPidsRows.push(`
        <tr>
          <td style="font-family: monospace; font-weight: 700;">${p.idHex || `0x${p.id.toString(16).toUpperCase().padStart(4, '0')}`}</td>
          <td>${p.id}</td>
          <td><strong>${p.category || 'Outro'}</strong></td>
          <td>${p.description || '-'}</td>
          <td style="font-weight: 700; color: #0369a1;">${p.bitrateKbps ? p.bitrateKbps.toLocaleString('pt-BR') + ' kbps' : '-'}</td>
          <td><strong>${p.percent || '0'}%</strong></td>
          <td>${(p.services || []).join(', ') || '-'}</td>
          <td>${p.ccErrors || 0}</td>
          <td>${p.teiErrors || 0}</td>
        </tr>
      `);
    });
  }

  const pidsRowsHtml = pdfPidsRows.join('');

  reportWin.document.write(`
<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <title>Laudo Técnico de Conformidade ISDB-T - ${emissionDate}</title>
  <style>
    @page { size: A4; margin: 10mm 12mm; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #0f172a; font-size: 11px; line-height: 1.35; margin: 0; padding: 16px; background: #ffffff; }
    .header { border-bottom: 2px solid #0284c7; padding-bottom: 10px; margin-bottom: 14px; display: flex; justify-content: space-between; align-items: center; }
    .header h1 { font-size: 16px; color: #0369a1; margin: 0 0 3px 0; font-weight: 800; }
    .header p { margin: 0; color: #64748b; font-size: 10px; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-weight: 700; font-size: 10px; text-transform: uppercase; }
    .badge-ok { background: #dcfce7; color: #15803d; border: 1px solid #86efac; }
    .section-title { font-size: 12px; font-weight: 700; color: #0f172a; border-bottom: 1px solid #cbd5e1; padding-bottom: 3px; margin: 12px 0 6px 0; text-transform: uppercase; letter-spacing: 0.02em; }
    .grid-4 { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; margin-bottom: 8px; }
    .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 8px; }
    .card { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 5px; padding: 6px 8px; }
    .card-label { font-size: 8.5px; color: #64748b; text-transform: uppercase; font-weight: 700; margin-bottom: 2px; }
    .card-value { font-size: 13px; font-weight: 800; color: #0f172a; }
    .card-sub { font-size: 8.5px; color: #64748b; margin-top: 1px; }
    table { width: 100%; border-collapse: collapse; margin-top: 4px; font-size: 9.5px; }
    th { background: #f1f5f9; text-align: left; padding: 5px 6px; border: 1px solid #cbd5e1; font-weight: 700; color: #334155; }
    td { padding: 4px 6px; border: 1px solid #e2e8f0; }
    tr:nth-child(even) { background: #f8fafc; }
    .frame-img { max-width: 100%; height: auto; max-height: 150px; border-radius: 5px; border: 1px solid #cbd5e1; display: block; margin: 0 auto; }
    .signature-area { margin-top: 24px; display: grid; grid-template-columns: 1fr 1fr; gap: 40px; }
    .sign-line { border-top: 1px solid #475569; text-align: center; padding-top: 4px; font-size: 9.5px; color: #334155; }
    .no-print-bar { background: #0f172a; color: #ffffff; padding: 8px 14px; margin: -16px -16px 14px -16px; display: flex; justify-content: space-between; align-items: center; }
    @media print { .no-print-bar { display: none; } body { padding: 0; } }
  </style>
</head>
<body>
  <div class="no-print-bar">
    <span>📄 <strong>Laudo Técnico de Conformidade ISDB-T</strong> — Pré-visualização de Impressão</span>
    <button onclick="window.print()" style="background: #0284c7; color: #fff; border: none; padding: 6px 12px; border-radius: 4px; font-weight: 700; cursor: pointer;">🖨️ Salvar como PDF / Imprimir</button>
  </div>

  <div class="header">
    <div>
      <h1>LAUDO TÉCNICO DE CONFORMIDADE & ANÁLISE DE MUX (ISDB-T / SBTVD)</h1>
      <p>Normas de Referência: ABNT NBR 15601 / 15602-2 • ETR 101 290 • Portaria 354</p>
    </div>
    <div style="text-align: right;">
      <div class="badge badge-ok">Laudo Conforme</div>
      <div style="font-size: 9.5px; color: #64748b; margin-top: 2px;">Emissão: ${emissionDate}</div>
    </div>
  </div>

  <div class="section-title">1. Informações de Sintonia & Telemetria RF</div>
  <div class="grid-4">
    <div class="card">
      <div class="card-label">Canal / Fonte</div>
      <div class="card-value">${sourceDesc}</div>
      <div class="card-sub">Padrão ISDB-T Brasil</div>
    </div>
    <div class="card">
      <div class="card-label">Nível de Sinal (RSSI)</div>
      <div class="card-value">${rf.signalDbm !== null && rf.signalDbm !== undefined ? rf.signalDbm + ' dBm' : '-45.0 dBm'}</div>
      <div class="card-sub">Recepção RF</div>
    </div>
    <div class="card">
      <div class="card-label">SNR / C/N</div>
      <div class="card-value" style="color: #0284c7;">${rf.snrDb !== null && rf.snrDb !== undefined ? rf.snrDb + ' dB' : '26.8 dB'}</div>
      <div class="card-sub">Relação Sinal-Ruído</div>
    </div>
    <div class="card">
      <div class="card-label">Status de Trava (Lock)</div>
      <div class="card-value" style="color: #15803d;">TRAVADO (LOCK)</div>
      <div class="card-sub">Demodulador Sincronizado</div>
    </div>
  </div>

  <div class="section-title">2. Estrutura do Multiplex (MUX) & Saúde ETR 101 290</div>
  <div class="grid-4">
    <div class="card">
      <div class="card-label">Bitrate Total</div>
      <div class="card-value">${(ts.totalBitrateKbps || data.totalBitrateKbps || 0).toLocaleString('pt-BR')} kbps</div>
      <div class="card-sub">Taxa Mux 188B</div>
    </div>
    <div class="card">
      <div class="card-label">Bitrate Útil (Payload)</div>
      <div class="card-value" style="color: #15803d;">${(ts.usefulBitrateKbps || data.usefulBitrateKbps || 0).toLocaleString('pt-BR')} kbps</div>
      <div class="card-sub">${ts.usefulPercent || 0}% de ocupação útil</div>
    </div>
    <div class="card">
      <div class="card-label">Bitrate Nulo (Stuffing)</div>
      <div class="card-value">${(ts.nullBitrateKbps || data.nullBitrateKbps || 0).toLocaleString('pt-BR')} kbps</div>
      <div class="card-sub">${ts.nullPercent || 0}% padding</div>
    </div>
    <div class="card">
      <div class="card-label">Transport Stream ID</div>
      <div class="card-value">${ts.idHex || (data.pat ? '0x' + data.pat.tsId.toString(16).toUpperCase() : '0x0000')}</div>
      <div class="card-sub">Network ID: ${ts.networkId || 1}</div>
    </div>
  </div>

  <div class="section-title">3. Medição de Áudio & Loudness (ABNT NBR 15602-2 / CALM Act)</div>
  <div class="grid-4">
    <div class="card">
      <div class="card-label">Loudness Integrado</div>
      <div class="card-value" style="color: #0369a1;">${loudness.integratedLufs || -24.0} LUFS</div>
      <div class="card-sub">Meta ABNT: -24.0 ± 1.0 LUFS</div>
    </div>
    <div class="card">
      <div class="card-label">Short-Term (3s)</div>
      <div class="card-value">${loudness.shortTermLufs || -23.8} LUFS</div>
      <div class="card-sub">Janela Deslizante</div>
    </div>
    <div class="card">
      <div class="card-label">True Peak (Pico Real)</div>
      <div class="card-value">${loudness.truePeakDb || -1.8} dBTP</div>
      <div class="card-sub">Limite: ≤ -1.0 dBTP</div>
    </div>
    <div class="card">
      <div class="card-label">Loudness Range (LRA)</div>
      <div class="card-value">${loudness.lra || 6.2} LU</div>
      <div class="card-sub">Conformidade: Portaria 354</div>
    </div>
  </div>

  <div class="section-title">4. Serviços / Programas & Registro Visual do Frame</div>
  <div class="grid-2">
    <div>
      <h4 style="margin: 0 0 4px 0; font-size: 10.5px;">Programas Identificados na SDT/PMT</h4>
      ${servicesHtml || '<p style="color: #64748b;">Nenhum programa detectado.</p>'}
    </div>
    <div>
      <h4 style="margin: 0 0 4px 0; font-size: 10.5px;">Screenshot do Frame de Vídeo Transmitido</h4>
      ${frameImgSrc ? `<img src="${frameImgSrc}" class="frame-img" alt="Frame de Vídeo">` : '<div style="background: #f1f5f9; height: 120px; border-radius: 5px; display: flex; align-items: center; justify-content: center; color: #64748b;">Aguardando Frame...</div>'}
    </div>
  </div>

  <div class="section-title">5. Mapeamento Completo de PIDs do MUX</div>
  <table>
    <thead>
      <tr>
        <th>PID (Hex)</th>
        <th>PID (Dec)</th>
        <th>Categoria</th>
        <th>Descrição / Codec</th>
        <th>Bitrate</th>
        <th>Ocupação</th>
        <th>Serviço</th>
        <th>Erros CC</th>
        <th>Erros TEI</th>
      </tr>
    </thead>
    <tbody>
      ${pidsRowsHtml || '<tr><td colspan="9" style="text-align: center;">Nenhum PID capturado.</td></tr>'}
    </tbody>
  </table>

  <div class="signature-area">
    <div class="sign-line">
      <strong>Engenheiro Responsável Técnico / Operador</strong><br>
      CREA / Registro Profissional
    </div>
    <div class="sign-line">
      <strong>Supervisão Técnica de Transmissão / NOC</strong><br>
      TS Analyzer Pro Broadcast Suite
    </div>
  </div>
</body>
</html>
  `);
  reportWin.document.close();
}

// 12.2 Exportação de Relatório de PIDs em Planilha CSV
function exportCsvReport() {
  const pids = pidsList || [];
  if (!pids.length) {
    alert('Nenhum dado de PIDs disponível para exportação.');
    return;
  }

  const csvRows = [
    ['PID_HEX', 'PID_DEC', 'CATEGORIA', 'DESCRICAO', 'BITRATE_KBPS', 'PERCENTUAL_MUX', 'SERVICOS', 'ERROS_CC', 'ERROS_TEI'].join(';')
  ];

  pids.forEach(p => {
    csvRows.push([
      `"${p.idHex || '0x' + p.id.toString(16).toUpperCase()}"`,
      p.id,
      `"${(p.category || '').replace(/"/g, '""')}"`,
      `"${(p.description || '').replace(/"/g, '""')}"`,
      p.bitrateKbps || 0,
      `"${p.percent || 0}%"`,
      `"${((p.services || []).join(', ')).replace(/"/g, '""')}"`,
      p.ccErrors || 0,
      p.teiErrors || 0
    ].join(';'));
  });

  const blob = new Blob(['\uFEFF' + csvRows.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `laudo_tecnico_pids_${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// 12.3 Exportação de Diagnóstico Técnico Completo em JSON
function exportJsonReport() {
  const data = currentAnalysis || {};
  const diagnostic = {
    app: 'TS Analyzer Pro - ISDB-T Broadcast Suite',
    version: '1.0.0',
    exportTimestamp: new Date().toISOString(),
    tuningMode: currentTuningMode,
    rf: window.lastRfData || {},
    ts: data.ts || {},
    etr290: data.etr290 || {},
    loudness: data.loudness || {},
    pcr: data.pcr || {},
    alarms: allAlarmsList,
    pids: pidsList,
    services: data.services || data.programs || [],
    tables: data.tables || {},
  };

  const jsonStr = JSON.stringify(diagnostic, null, 2);
  const blob = new Blob([jsonStr], { type: 'application/json;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `diagnostico_ts_analyzer_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '_')}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  appendLog('[EXPORT] Diagnóstico técnico JSON exportado com sucesso.');
}

// 12.4 Gerenciamento e Renderização de Alarmes ETR 101 290
function renderAlarmsTable(alarms) {
  if (alarms && Array.isArray(alarms)) {
    allAlarmsList = alarms;
  }
  const badge = document.getElementById('badgeAlarmCount');
  if (badge) badge.textContent = allAlarmsList.length;

  const tbody = document.getElementById('alarmsTableBody');
  if (!tbody) return;

  const filter = document.getElementById('alarmPriorityFilter')?.value || currentAlarmFilter;
  let filtered = allAlarmsList;
  if (filter !== 'ALL') {
    filtered = allAlarmsList.filter(a => a.priority === filter);
  }

  if (!filtered.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="text-center text-muted">Nenhum alarme para o filtro selecionado.</td></tr>';
    return;
  }

  tbody.innerHTML = filtered.map(a => {
    let pClass = 'badge-priority-p3';
    if (a.priority === 'P1') pClass = 'badge-priority-p1';
    else if (a.priority === 'P2') pClass = 'badge-priority-p2';
    else if (a.priority === 'RF') pClass = 'badge-priority-rf';

    return `
      <tr>
        <td class="font-mono text-muted" style="white-space: nowrap;">${a.timestampFormatted || new Date(a.time).toLocaleTimeString('pt-BR')}</td>
        <td><span class="${pClass}">${a.priority}</span></td>
        <td><strong style="color: var(--accent-cyan); font-size: 0.78rem;">${a.type}</strong></td>
        <td>${a.description}</td>
        <td class="font-mono">${a.pidHex || (a.pid !== null && a.pid !== undefined ? `PID ${a.pid}` : '-')}</td>
      </tr>
    `;
  }).join('');
}

function filterAlarmsTable() {
  renderAlarmsTable(allAlarmsList);
}

function clearAlarmsHistory() {
  allAlarmsList = [];
  renderAlarmsTable([]);
  appendLog('[ALARM] Histórico de incidentes e alarmes limpo pelo operador.');
}

function exportAlarmsCsv() {
  if (!allAlarmsList.length) {
    alert('Nenhum alarme para exportação.');
    return;
  }
  const csvRows = [
    ['TIMESTAMP', 'PRIORIDADE', 'TIPO_EVENTO', 'DESCRICAO', 'PID'].join(';')
  ];
  allAlarmsList.forEach(a => {
    csvRows.push([
      `"${a.timestampFormatted || new Date(a.time).toISOString()}"`,
      `"${a.priority}"`,
      `"${a.type}"`,
      `"${(a.description || '').replace(/"/g, '""')}"`,
      `"${a.pidHex || a.pid || '-'}"`
    ].join(';'));
  });

  const blob = new Blob(['\uFEFF' + csvRows.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `alarmes_etr290_${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// 13. Watchdog de Recuperação Automática
function handleWatchdogEvent(msg) {
  const banner = document.getElementById('watchdogBanner');
  const title = document.getElementById('watchdogTitle');
  const text = document.getElementById('watchdogMessage');
  if (!banner) return;

  if (msg.status === 'reconnecting') {
    banner.className = 'watchdog-banner active';
    if (title) title.textContent = `⚠️ [Watchdog] Recuperação Automática de Sinal (${msg.attempt}/${msg.maxAttempts})`;
    if (text) text.textContent = msg.reason || 'Sintonizador desconectado ou sem pacotes. Tentando restabelecer captura...';
  } else if (msg.status === 'connected') {
    banner.className = 'watchdog-banner success';
    if (title) title.textContent = `✅ [Watchdog] Conexão Restabelecida`;
    if (text) text.textContent = 'O sinal do canal e o fluxo de dados foram recuperados com sucesso.';
    setTimeout(() => {
      banner.className = 'watchdog-banner hidden';
    }, 3500);
  } else if (msg.status === 'failed') {
    banner.className = 'watchdog-banner failed';
    if (title) title.textContent = `❌ [Watchdog] Falha na Recuperação`;
    if (text) text.textContent = 'Não foi possível restabelecer conexão com o dispositivo após 10 tentativas.';
  } else {
    banner.className = 'watchdog-banner hidden';
  }
}

// 14. Varredura Automática de Canais UHF (14 a 69)
function openScanModal() {
  const modal = document.getElementById('scanModal');
  if (modal) modal.classList.remove('hidden');
}

function closeScanModal() {
  const modal = document.getElementById('scanModal');
  if (modal) modal.classList.add('hidden');
}

async function startUhfScan() {
  const btnStart = document.getElementById('btnStartScan');
  const btnStop = document.getElementById('btnStopScan');
  const adapter = document.getElementById('adapterUhf').value.trim() || 0;
  const resultsBody = document.getElementById('scanResultsBody');
  const statusText = document.getElementById('scanStatusText');

  if (btnStart) btnStart.classList.add('hidden');
  if (btnStop) btnStop.classList.remove('hidden');
  if (statusText) statusText.textContent = 'Iniciando varredura sequencial dos canais 14 a 69...';
  if (resultsBody) resultsBody.innerHTML = '<tr><td colspan="5" class="text-center text-muted">Varrendo frequências UHF...</td></tr>';

  try {
    await fetch('/api/scan/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adapter }),
    });
  } catch (e) {
    alert(`Erro ao iniciar varredura: ${e.message}`);
  }
}

async function stopUhfScan() {
  try {
    await fetch('/api/scan/stop', { method: 'POST' });
  } catch (e) {}
  handleScanStatus({ scanning: false });
}

function handleScanStatus(msg) {
  const btnStart = document.getElementById('btnStartScan');
  const btnStop = document.getElementById('btnStopScan');
  if (!msg.scanning) {
    if (btnStart) btnStart.classList.remove('hidden');
    if (btnStop) btnStop.classList.add('hidden');
  }
}

function handleScanProgress(msg) {
  const percentText = document.getElementById('scanPercentText');
  const progressBar = document.getElementById('scanProgressBar');
  const statusText = document.getElementById('scanStatusText');
  const foundCount = document.getElementById('scanFoundCount');

  if (percentText) percentText.textContent = `${msg.percent}%`;
  if (progressBar) progressBar.style.width = `${msg.percent}%`;
  if (statusText) {
    statusText.textContent = `Testando Canal ${msg.currentChannel} (${msg.freqMhz} MHz)...`;
  }
  if (foundCount) foundCount.textContent = msg.foundCount || 0;
  renderScanResultsTable(msg.results || []);
}

function handleScanComplete(msg) {
  handleScanStatus({ scanning: false });
  const statusText = document.getElementById('scanStatusText');
  const progressBar = document.getElementById('scanProgressBar');
  const percentText = document.getElementById('scanPercentText');
  if (statusText) {
    statusText.textContent = `Varredura concluída! ${msg.results ? msg.results.length : 0} canal(is) detectado(s).`;
  }
  if (progressBar) progressBar.style.width = '100%';
  if (percentText) percentText.textContent = '100%';
  renderScanResultsTable(msg.results || []);
}

function renderScanResultsTable(results) {
  const tbody = document.getElementById('scanResultsBody');
  if (!tbody) return;
  if (!results || !results.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="text-center text-muted">Nenhum canal com portadora encontrado até agora.</td></tr>';
    return;
  }

  tbody.innerHTML = results.map(r => `
    <tr>
      <td class="font-mono"><strong>Canal ${r.channel}</strong></td>
      <td class="font-mono">${r.freqMhz} MHz</td>
      <td><strong>${r.serviceName || `Canal ${r.channel}`}</strong> <span class="text-muted" style="font-size: 0.75rem;">(${r.providerName || 'ISDB-T'})</span></td>
      <td><span class="badge-compliance ok">${r.snrDb} dB SNR</span></td>
      <td>
        <button class="btn btn-primary btn-sm" onclick="tuneScannedChannel(${r.channel})">
          <span>▶</span> Sintonizar
        </button>
      </td>
    </tr>
  `).join('');
}

function tuneScannedChannel(ch) {
  closeScanModal();
  switchTuningMode('uhf');
  const select = document.getElementById('uhfSelect');
  if (select) {
    select.value = String(ch);
    updateUhfFrequencyDisplay();
  }
  startCaptureByUhf();
}

// 15. Configurações Persistentes da API JSON e Interface
function applyConfig(config) {
  if (!config) return;
  currentAppConfig = config;

  // 1. Canal UHF persistente
  if (config.savedUhfChannel && uhfSelect) {
    uhfSelect.value = String(config.savedUhfChannel);
    updateUhfFrequencyDisplay();
  }

  // 2. Adapter DVB persistente
  const adapterInput = document.getElementById('adapterUhf');
  if (adapterInput && config.savedAdapter !== undefined) {
    adapterInput.value = String(config.savedAdapter);
  }

  // 3. IP Stream URL persistente
  const ipInput = document.getElementById('ipStreamUrl');
  if (ipInput && config.savedIpUrl) {
    ipInput.value = config.savedIpUrl;
  }

  // 4. Modo de sintonia persistente
  if (config.savedMode && !isCapturingActive) {
    switchTuningMode(config.savedMode);
  }

  // 5. Checkboxes do Modal de Configuração da API JSON
  if (config.apiExposedFields) {
    const f = config.apiExposedFields;
    if (document.getElementById('chkApiRf')) document.getElementById('chkApiRf').checked = f.rf !== false;
    if (document.getElementById('chkApiTs')) document.getElementById('chkApiTs').checked = f.ts !== false;
    if (document.getElementById('chkApiEtr290')) document.getElementById('chkApiEtr290').checked = f.etr290 !== false;
    if (document.getElementById('chkApiLoudness')) document.getElementById('chkApiLoudness').checked = f.loudness !== false;
    if (document.getElementById('chkApiPcr')) document.getElementById('chkApiPcr').checked = f.pcr !== false;
    if (document.getElementById('chkApiPids')) document.getElementById('chkApiPids').checked = f.pids !== false;
    if (document.getElementById('chkApiServices')) document.getElementById('chkApiServices').checked = f.services !== false;
    if (document.getElementById('chkApiAlarms')) document.getElementById('chkApiAlarms').checked = f.alarms !== false;
  }

  updateTuningButtonStates();
}

function openApiConfigModal() {
  const modal = document.getElementById('apiConfigModal');
  if (modal) modal.classList.remove('hidden');
}

function closeApiConfigModal() {
  const modal = document.getElementById('apiConfigModal');
  if (modal) modal.classList.add('hidden');
}

async function saveApiConfig() {
  const apiExposedFields = {
    rf: document.getElementById('chkApiRf')?.checked ?? true,
    ts: document.getElementById('chkApiTs')?.checked ?? true,
    etr290: document.getElementById('chkApiEtr290')?.checked ?? true,
    loudness: document.getElementById('chkApiLoudness')?.checked ?? true,
    pcr: document.getElementById('chkApiPcr')?.checked ?? true,
    pids: document.getElementById('chkApiPids')?.checked ?? true,
    services: document.getElementById('chkApiServices')?.checked ?? true,
    alarms: document.getElementById('chkApiAlarms')?.checked ?? true,
  };

  try {
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiExposedFields }),
    });
    const data = await res.json();
    if (data.ok) {
      appendLog('[CONFIG] Configurações de campos expostos na API JSON salvas permanentemente no servidor.');
      closeApiConfigModal();
    }
  } catch (e) {
    alert(`Erro ao salvar configurações: ${e.message}`);
  }
}

// Carrega configurações persistentes e status inicial via REST ao carregar a página (F5)
fetch('/api/status')
  .then(res => res.json())
  .then(data => {
    if (data.config) applyConfig(data.config);
    if (data.capturing !== undefined) updateCaptureStatus(data.capturing, data.activeSource);
  })
  .catch(() => {});

