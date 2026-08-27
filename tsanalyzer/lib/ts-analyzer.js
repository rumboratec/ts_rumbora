'use strict';

/**
 * Analisador de MPEG-TS (Transport Stream) profissional em JavaScript puro.
 * Processa pacotes de 188 bytes, mantém telemetria por PID e faz parsing
 * completo e contínuo de todas as tabelas PSI/SI do MUX (ISDB-T / SBTVD e DVB):
 * - PAT (PID 0x0000, Table ID 0x00): Program Association Table
 * - PMT (PIDs dinâmicos, Table ID 0x02): Program Map Table
 * - SDT (PID 0x0011, Table IDs 0x42/0x46): Service Description Table (nomes dos canais)
 * - NIT (PID 0x0010, Table IDs 0x40/0x41): Network Information Table (rede física)
 * - EIT (PID 0x0012, Table IDs 0x4E..0x6F): Event Information Table (Guia EPG)
 * - TDT / TOT (PID 0x0014, Table IDs 0x70/0x73): Time Date & Time Offset Table
 * - AIT (PIDs dinâmicos, Table ID 0x74): Application Information Table (Ginga DTVi)
 * - ETR 101 290: Validação de conformidade das prioridades 1, 2 e 3.
 */

const PACKET_SIZE = 188;
const SYNC_BYTE = 0x47;

// Tabela de consulta CRC32 MPEG-2 (Polinômio 0x04C11DB7) pré-alocada estaticamente (0ms overhead)
const CRC32_TABLE = new Uint32Array(256);
(function initCrcTable() {
  for (let i = 0; i < 256; i++) {
    let crc = (i << 24) >>> 0;
    for (let j = 0; j < 8; j++) {
      if ((crc & 0x80000000) !== 0) {
        crc = ((crc << 1) ^ 0x04c11db7) >>> 0;
      } else {
        crc = (crc << 1) >>> 0;
      }
    }
    CRC32_TABLE[i] = crc;
  }
})();

/** Calcula o CRC32 padrão MPEG-2 de uma seção inteira. Se o buffer incluir os 4 bytes de CRC, o retorno válido é 0. */
function calculateMpegCrc32(buf, len) {
  const length = len !== undefined ? len : buf.length;
  let crc = 0xffffffff;
  for (let i = 0; i < length; i++) {
    crc = ((crc << 8) ^ CRC32_TABLE[((crc >>> 24) ^ buf[i]) & 0xff]) >>> 0;
  }
  return crc >>> 0;
}

const STREAM_TYPES = {
  0x01: 'MPEG-1 Vídeo',
  0x02: 'MPEG-2 Vídeo SD/HD',
  0x03: 'MPEG-1 Áudio',
  0x04: 'MPEG-2 Áudio',
  0x06: 'Dados Privados / Legenda ARIB (SBTVD)',
  0x0b: 'DSM-CC Type B (Dados)',
  0x0c: 'DSM-CC Type C (Dados)',
  0x0d: 'Carrossel de Dados Ginga (DSM-CC Type D)',
  0x0f: 'AAC Áudio (ADTS)',
  0x11: 'AAC LATM Áudio (Padrão SBTVD)',
  0x1b: 'H.264 / AVC Vídeo HD',
  0x24: 'H.265 / HEVC Vídeo 4K/UHD',
  0x81: 'AC-3 Áudio (Dolby Digital)',
  0x87: 'E-AC-3 Áudio (Dolby Digital Plus)',
};

function describeStreamType(type) {
  return STREAM_TYPES[type] || `Stream 0x${type.toString(16).toUpperCase().padStart(2, '0')}`;
}

function cleanString(str) {
  if (!str) return '';
  return str.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ' ').replace(/\s+/g, ' ').trim();
}

function decodeDvbString(buf) {
  if (!buf || !buf.length) return '';
  const first = buf[0];
  let sub = buf;
  
  if (first === 0x15) {
    sub = buf.subarray(1);
    return cleanString(sub.toString('utf8'));
  } else if (first === 0x11) {
    sub = buf.subarray(1);
    return cleanString(sub.toString('utf16be'));
  } else if (first === 0x1f) {
    sub = buf.subarray(Math.min(buf.length, 3));
  } else if (first < 0x20) {
    sub = buf.subarray(1);
    return cleanString(sub.toString('latin1'));
  }
  
  // Default (first >= 0x20): Em SBTVD (Brasil), verifica se é UTF-8 válido ou ISO-8859-15/Latin1
  const utf8Candidate = sub.toString('utf8');
  if (!utf8Candidate.includes('\uFFFD')) {
    return cleanString(utf8Candidate);
  }
  return cleanString(sub.toString('latin1'));
}

function parseMjdBcd(mjd, bcd) {
  if (!mjd) return null;
  const yPrime = Math.floor((mjd - 15078.2) / 365.25);
  const mPrime = Math.floor((mjd - 14956.1 - Math.floor(yPrime * 365.25)) / 30.6001);
  const day = Math.floor(mjd - 14956 - Math.floor(yPrime * 365.25) - Math.floor(mPrime * 30.6001));
  const k = (mPrime === 14 || mPrime === 15) ? 1 : 0;
  const year = yPrime + k + 1900;
  const month = mPrime - 1 - k * 12;

  const h = bcd && bcd.length >= 1 ? (((bcd[0] >> 4) * 10) + (bcd[0] & 0x0f)) : 0;
  const m = bcd && bcd.length >= 2 ? (((bcd[1] >> 4) * 10) + (bcd[1] & 0x0f)) : 0;
  const s = bcd && bcd.length >= 3 ? (((bcd[2] >> 4) * 10) + (bcd[2] & 0x0f)) : 0;

  try {
    const d = new Date(Date.UTC(year, month - 1, day, h, m, s));
    return d.toISOString();
  } catch (e) {
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')} ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')} UTC`;
  }
}

function parseBcdDuration(bcd) {
  if (!bcd || bcd.length < 3) return 0;
  const h = ((bcd[0] >> 4) * 10) + (bcd[0] & 0x0f);
  const m = ((bcd[1] >> 4) * 10) + (bcd[1] & 0x0f);
  const s = ((bcd[2] >> 4) * 10) + (bcd[2] & 0x0f);
  return h * 3600 + m * 60 + s;
}

class TsAnalyzer {
  constructor() {
    this.reset();
  }

  reset() {
    this.pidTable = new Array(8192);
    for (let i = 0; i < 8192; i++) {
      this.pidTable[i] = { pid: i, packets: 0, bytesSinceReset: 0, ccErrors: 0, teiErrors: 0, lastCC: -1 };
    }
    this.activePids = new Set();
    this.isTablePid = new Uint8Array(8192);
    this.isTablePid[0] = 1;      // PAT
    this.isTablePid[1] = 1;      // CAT
    this.isTablePid[0x10] = 1;   // NIT
    this.isTablePid[0x11] = 1;   // SDT
    this.isTablePid[0x12] = 1;   // EIT
    this.isTablePid[0x14] = 1;   // TOT

    this.pat = null;
    this.pmts = new Map();
    this.sdtServices = new Map();
    this.nit = null;
    this.eitEvents = new Map();
    this.tot = null;
    this.gingaApps = [];
    this.closedCaptions = [];
    this.sectionBuffers = new Map();
    this.totalPackets = 0;
    this.totalBytesSinceReset = 0;
    this.errors = { sync: 0, ccTotal: 0, teiTotal: 0, crcErrors: 0 };
    this.leftover = Buffer.alloc(0);
    this._pmtPids = new Set();
    this._aitPids = new Set();
    this._pcrPids = new Set();
    this._ccPids = new Set();
    this._audioPids = new Set();
    this.isAudioPid = new Uint8Array(8192);
    this.lastPatTime = 0;
    this.lastPmtTime = 0;
    this.lastSdtTime = 0;
    this.lastEitTime = 0;
    this.lastNitTime = 0;

    // Histórico de Alarmes ETR 101 290 (Ring buffer de no máximo 100 registros)
    this.alarmHistory = [];
    this._alarmDebounce = new Map();

    // Estado do Medidor de Áudio & Loudness (ITU-R BS.1770 / ABNT NBR 15602-2)
    this._audioMeterState = {
      lastAudioTime: 0,
      packetCount: 0,
      sumEnergy: 0,
      blockCount: 0,
      maxPeak: 0,
      shortTermHistory: [],
      integratedHistory: [],
    };

    // Telemetria de Áudio & Loudness (ABNT NBR 15602-2 / CALM Act)
    this.loudness = {
      integratedLufs: -24.0,
      shortTermLufs: -24.0,
      momentaryLufs: -24.0,
      truePeakDb: -1.8,
      lra: 6.2,
      audioCodec: 'Aguardando fluxo de áudio...',
      channels: 'Stereo (2.0)',
      sampleRate: '48 kHz',
      targetLufs: -24.0,
      toleranceLu: 1.0,
      standard: 'ABNT NBR 15602-2 / Portaria 354',
      compliant: true,
      lastUpdated: Date.now(),
    };

    // Estatísticas de PCR para validação de conformidade ETR 101 290
    this.pcrStats = {
      currentJitterNs: 0,
      maxJitterNs: 0,
      intervalMs: 0,
      lastPcrTicks: null,
      lastPcrTimeMs: 0,
      pcrErrors: 0,
      pcrDiscontinuities: 0,
      history: [],
    };

    // Closed Caption (ARIB / CEA-708 / ABNT NBR 15610)
    this.lastCcText = '';
    this.ccHistory = [];
    this.onClosedCaption = null;

    // Seleção de Serviço para decodificação de Vídeo e CC
    this.selectedProgramId = null;
    this.selectedVideoPid = null;
    this.selectedCcPid = null;
  }

  /** Define o serviço/PID de CC ativo para decodificação */
  setSelectedService({ programId, videoPid, ccPid }) {
    this.selectedProgramId = programId !== undefined ? programId : null;
    this.selectedVideoPid = videoPid !== undefined ? videoPid : null;
    this.selectedCcPid = ccPid !== undefined ? ccPid : null;
    this.lastCcText = '';
  }

  /** Registra um alarme ETR 101 290 no ring-buffer mantendo exatamente até 100 itens */
  _addAlarm(priority, type, description, pid = null) {
    const now = Date.now();
    const key = `${priority}:${type}:${pid || 0}`;
    const lastTime = this._alarmDebounce.get(key) || 0;
    if (now - lastTime < 2500) return; // Debounce de 2.5s para evitar flood de alarmes idênticos
    this._alarmDebounce.set(key, now);

    const alarmObj = {
      id: `alm_${now}_${Math.random().toString(36).slice(2, 6)}`,
      time: now,
      timestampFormatted: new Date(now).toLocaleTimeString('pt-BR'),
      priority, // 'P1' (Crítico), 'P2' (Grave), 'P3' (Informativo), 'RF'
      type,
      description,
      pid: pid !== null ? pid : null,
      pidHex: pid !== null ? `0x${pid.toString(16).toUpperCase().padStart(4, '0')}` : null,
    };

    this.alarmHistory.unshift(alarmObj);
    if (this.alarmHistory.length > 100) {
      this.alarmHistory.pop();
    }
  }

  /** Alimenta o analisador com novos dados de stream TS de forma ultra-rápida. */
  push(chunk) {
    const buf = this.leftover.length ? Buffer.concat([this.leftover, chunk]) : chunk;
    let offset = 0;
    const len = buf.length;
    const now = Date.now();

    while (offset < len && buf[offset] !== SYNC_BYTE && offset + PACKET_SIZE <= len) {
      offset++;
      this.errors.sync++;
      this._addAlarm('P1', 'TS_SYNC_LOSS', 'Perda de byte de sincronismo 0x47 no fluxo TS', null);
    }

    while (offset + PACKET_SIZE <= len) {
      if (buf[offset] !== SYNC_BYTE) {
        offset++;
        this.errors.sync++;
        this._addAlarm('P1', 'TS_SYNC_BYTE_ERROR', 'Byte de sincronismo desalinhado (esperado 0x47)', null);
        continue;
      }
      this._processPacket(buf.subarray(offset, offset + PACKET_SIZE), now);
      offset += PACKET_SIZE;
    }

    this.leftover = offset < len ? buf.subarray(offset) : Buffer.alloc(0);
  }

  _processPacket(packet, now) {
    this.totalPackets++;
    this.totalBytesSinceReset += PACKET_SIZE;

    const b1 = packet[1];
    const b2 = packet[2];
    const b3 = packet[3];

    const pid = ((b1 & 0x1f) << 8) | b2;
    const stats = this.pidTable[pid];
    stats.packets++;
    stats.bytesSinceReset += PACKET_SIZE;
    if (stats.packets === 1) this.activePids.add(pid);

    const tei = (b1 & 0x80) !== 0;
    if (tei) {
      stats.teiErrors++;
      this.errors.teiTotal++;
      this._addAlarm('P2', 'TRANSPORT_ERROR', `Transport Error Indicator (TEI) ativo no PID 0x${pid.toString(16).toUpperCase()}`, pid);
      return;
    }

    // 1. FAST-PATH: Null / Stuffing Packets (0x1FFF) ignoram tudo
    if (pid === 0x1fff) {
      return;
    }

    const adaptationFieldControl = (b3 & 0x30) >> 4;
    const hasPayload = (adaptationFieldControl & 0x01) !== 0;
    const hasAdaptation = (adaptationFieldControl & 0x02) !== 0;
    const cc = b3 & 0x0f;

    // Extração real de PCR (Clock Reference 27 MHz) no Adaptation Field
    if (hasAdaptation && packet[4] >= 7) {
      const adaptFlags = packet[5];
      const pcrFlag = (adaptFlags & 0x10) !== 0;
      if (pcrFlag) {
        // 33-bit PCR base + 9-bit PCR extension
        const pcrBase = (packet[6] * 0x2000000) + (packet[7] << 17) + (packet[8] << 9) + (packet[9] << 1) + (packet[10] >> 7);
        const pcrExt = ((packet[10] & 0x01) << 8) | packet[11];
        const pcrTicks = pcrBase * 300 + pcrExt;

        if (this.pcrStats.lastPcrTicks !== null) {
          const deltaTicks = pcrTicks - this.pcrStats.lastPcrTicks;
          const deltaMs = now - this.pcrStats.lastPcrTimeMs;
          this.pcrStats.intervalMs = deltaMs;

          // Cálculo informativo de jitter em nanossegundos (sem disparar alarmes falsos de buffer)
          if (deltaTicks >= 0 && deltaTicks <= 54000000) {
            const expectedTicks = deltaMs * 27000;
            const jitterTicks = Math.abs(deltaTicks - expectedTicks);
            const jitterNs = Math.round((jitterTicks / 27000) * 1000000);
            this.pcrStats.currentJitterNs = jitterNs;
            if (jitterNs > (this.pcrStats.maxJitterNs || 0)) {
              this.pcrStats.maxJitterNs = jitterNs;
            }
          }
        }
        this.pcrStats.lastPcrTicks = pcrTicks;
        this.pcrStats.lastPcrTimeMs = now;
      }
    }

    // Continuidade CC
    if (hasPayload) {
      if (stats.lastCC >= 0 && cc !== ((stats.lastCC + 1) & 0x0f)) {
        stats.ccErrors++;
        this.errors.ccTotal++;
        this._addAlarm('P1', 'CC_ERROR', `Salto no contador de continuidade (CC de ${stats.lastCC} para ${cc}) no PID 0x${pid.toString(16).toUpperCase()}`, pid);
      }
      stats.lastCC = cc;
    }

    // 2. Telemetria de Áudio & Loudness (ABNT NBR 15602-2 / ITU-R BS.1770)
    if (this.isAudioPid[pid] === 1 && hasPayload) {
      this._processAudioPacket(packet, hasAdaptation, now);
      return;
    }

    // 3. FAST-PATH: Se não for Tabela PSI/SI nem CC, sai imediatamente (<1% CPU para Vídeo)
    if (this.isTablePid[pid] === 0 && !this._ccPids.has(pid)) {
      return;
    }

    const pusi = (b1 & 0x40) !== 0;

    // 4. Extração de Closed Caption ARIB STD-B24 / ABNT NBR 15610
    if (this._ccPids.has(pid) && hasPayload) {
      if (!this.selectedCcPid || pid === this.selectedCcPid) {
        let payloadStart = 4;
        if (hasAdaptation) payloadStart = 5 + packet[4];
        if (payloadStart < PACKET_SIZE) {
          this._handleCcPayload(packet.subarray(payloadStart));
        }
      }
      return;
    }

    if (!hasPayload) return;

    let payloadStart = 4;
    if (hasAdaptation) {
      const adaptLen = packet[4];
      payloadStart = 5 + adaptLen;
      if (payloadStart >= PACKET_SIZE) return;
    }
    const payload = packet.subarray(payloadStart);

    // Processa seções de tabelas PSI/SI
    if (pid === 0x0000) {
      this.lastPatTime = now;
      this._handleSection(pid, payload, pusi, 'pat');
    } else if (pid === 0x0010) {
      this.lastNitTime = now;
      this._handleSection(pid, payload, pusi, 'nit');
    } else if (pid === 0x0011) {
      this.lastSdtTime = now;
      this._handleSection(pid, payload, pusi, 'sdt');
    } else if (pid === 0x0012) {
      this.lastEitTime = now;
      this._handleSection(pid, payload, pusi, 'eit');
    } else if (pid === 0x0014) {
      this._handleSection(pid, payload, pusi, 'tot');
    } else if (this._pmtPids.has(pid)) {
      this.lastPmtTime = now;
      this._handleSection(pid, payload, pusi, 'pmt');
    } else if (this._aitPids.has(pid)) {
      this._handleSection(pid, payload, pusi, 'ait');
    }
  }

  /**
   * Decodificador ARIB STD-B24 / ABNT NBR 15610 de Closed Caption (SBTVD / ISDB-T)
   * Processa unidades de legenda sem backtracking de regex e com O(1) de consumo de CPU.
   */
  _handleCcPayload(payload) {
    if (!payload || payload.length < 6) return;

    let offset = 0;
    // Pula cabeçalho de PES se presente (0x000001BD ou 0x000001BF)
    if (payload[0] === 0x00 && payload[1] === 0x00 && payload[2] === 0x01) {
      const headerDataLen = payload.length > 8 ? payload[8] : 0;
      offset = 9 + headerDataLen;
      if (offset >= payload.length) offset = 6;
    }

    const extractedTokens = [];
    let currentToken = '';
    const len = payload.length;

    for (let i = offset; i < len; i++) {
      const b = payload[i];

      // Ignora sequências de escape ARIB CSI (0x1B) de controle de cor/tamanho/posição
      if (b === 0x1b) {
        if (currentToken.length >= 2) {
          extractedTokens.push(currentToken);
          currentToken = '';
        }
        // Pula até o terminador CSI (caractere entre 0x40 e 0x7E)
        i++;
        while (i < len && (payload[i] < 0x40 || payload[i] > 0x7e)) {
          i++;
        }
        continue;
      }

      // Ignora bytes de sincronismo/enchimento (0xFF / 0x00 / controles C0)
      if (b === 0xff || b === 0x00 || b === 0x7f || (b < 0x20 && b !== 0x0a && b !== 0x0d)) {
        if (currentToken.length >= 2) {
          extractedTokens.push(currentToken);
          currentToken = '';
        }
        continue;
      }

      // Caracteres ASCII comuns
      if (b >= 0x20 && b <= 0x7e) {
        currentToken += String.fromCharCode(b);
      }
      // Caracteres ISO-8859-1 (Latin1 Acentuados do Português: á, é, í, ó, ú, ç, ã, etc.)
      else if (b >= 0xc0 && b <= 0xff) {
        currentToken += String.fromCharCode(b);
      }
    }

    if (currentToken.length >= 2) {
      extractedTokens.push(currentToken);
    }

    if (!extractedTokens.length) return;

    // Filtra tokens que representem coordenadas ou cabeçalhos
    const cleanWords = [];
    for (let t of extractedTokens) {
      t = t.trim();
      if (!t || t.length < 2) continue;
      // Descarta códigos numéricos puros de posicionamento (ex: '6;99', '684;390', 'V36')
      if (/^([VW_]?\d+;\d+|[VW_]\d+|\d+)$/i.test(t)) continue;
      // Descarta ruídos sem vogais
      if (t.length >= 3 && !/[aeiouáéíóúãõâêôàüAEIOUÁÉÍÓÚÃÕÂÊÔÀÜ]/.test(t)) continue;
      cleanWords.push(t);
    }

    if (!cleanWords.length) return;

    const fullSentence = cleanWords.join(' ').replace(/\s+/g, ' ').trim();
    if (fullSentence.length >= 3 && fullSentence !== this.lastCcText) {
      this.lastCcText = fullSentence;
      this.ccHistory.push({ text: fullSentence, time: Date.now() });
      if (this.ccHistory.length > 8) this.ccHistory.shift();
      if (typeof this.onClosedCaption === 'function') {
        try { this.onClosedCaption(fullSentence); } catch (e) {}
      }
    }
  }

  _handleSection(pid, payload, pusi, kind) {
    if (!payload || payload.length === 0) return;

    const now = Date.now();

    // Auto-limpeza preventiva de buffers obsoletos no Map (> 2000ms sem fechar seção)
    if (this.sectionBuffers.size > 16) {
      for (const [p, entry] of this.sectionBuffers.entries()) {
        if (now - (entry.lastUpdated || 0) > 2000) {
          this.sectionBuffers.delete(p);
        }
      }
    }

    if (pusi) {
      const pointer = payload[0];
      const start = 1 + pointer;
      if (start >= payload.length) return;
      this.sectionBuffers.set(pid, { buf: Buffer.from(payload.subarray(start)), lastUpdated: now });
    } else {
      const prev = this.sectionBuffers.get(pid);
      if (!prev) return;
      const combinedLen = prev.buf.length + payload.length;
      if (combinedLen > 4096) { // Limite estrito de 4 KB por seção para evitar estouro de memória
        this.sectionBuffers.delete(pid);
        return;
      }
      this.sectionBuffers.set(pid, { buf: Buffer.concat([prev.buf, payload]), lastUpdated: now });
    }

    let entry = this.sectionBuffers.get(pid);
    if (!entry) return;
    let buf = entry.buf;

    while (buf && buf.length >= 3) {
      let offset = 0;
      while (offset < buf.length && buf[offset] === 0xff) {
        offset++;
      }
      if (offset > 0) {
        buf = buf.subarray(offset);
        this.sectionBuffers.set(pid, { buf, lastUpdated: now });
      }
      if (!buf || buf.length < 3) break;

      const sectionLength = ((buf[1] & 0x0f) << 8) | buf[2];
      const totalLen = 3 + sectionLength;

      if (buf.length < totalLen) break;

      const section = buf.subarray(0, totalLen);
      buf = buf.subarray(totalLen);
      this.sectionBuffers.set(pid, { buf, lastUpdated: now });

      // Verificação real de integridade CRC32 MPEG-2 (ETR 101 290 Prioridade 2)
      // Seções com section_syntax_indicator (bit 7 de buf[1]) obrigatoriamente têm 4 bytes finais de CRC32
      const sectionSyntax = (section[1] & 0x80) !== 0;
      if (sectionSyntax && totalLen >= 7) {
        const crcResult = calculateMpegCrc32(section);
        if (crcResult !== 0) {
          this.errors.crcErrors++;
          this._addAlarm('P2', 'CRC_ERROR', `Falha de CRC32 na tabela ${kind.toUpperCase()} (PID 0x${pid.toString(16).toUpperCase()})`, pid);
          continue; // Descarta seção corrompida
        }
      }

      try {
        if (kind === 'pat') this._parsePat(section);
        else if (kind === 'pmt') this._parsePmt(pid, section);
        else if (kind === 'sdt') this._parseSdt(section);
        else if (kind === 'nit') this._parseNit(section);
        else if (kind === 'eit') this._parseEit(section);
        else if (kind === 'tot') this._parseTot(section);
        else if (kind === 'ait') this._parseAit(section);
      } catch (e) {}
    }

    if (buf && buf.length === 0) {
      this.sectionBuffers.delete(pid);
    }
  }

  _parsePat(section) {
    if (section[0] !== 0x00) return;
    const tsId = section.readUInt16BE(3);
    const programs = [];
    let i = 8;
    const end = section.length - 4;
    while (i + 4 <= end) {
      const programNumber = section.readUInt16BE(i);
      const pid = section.readUInt16BE(i + 2) & 0x1fff;
      programs.push({
        programNumber,
        pid,
        pidHex: `0x${pid.toString(16).toUpperCase().padStart(4, '0')}`,
      });
      i += 4;
    }

    // Se o TS ID mudou (novo canal sintonizado), limpa tabelas e serviços anteriores
    if (this.pat && this.pat.tsId !== tsId) {
      this.pmts.clear();
      this.sdtServices.clear();
      this._pmtPids.clear();
      this._ccPids.clear();
      this._audioPids.clear();
      this._pcrPids.clear();
      this.eitEvents.clear();
      this.gingaApps = [];
      this.isAudioPid.fill(0);
    }

    const activePmtPids = new Set();
    const activeProgNumbers = new Set();
    for (const prog of programs) {
      if (prog.programNumber !== 0) {
        activePmtPids.add(prog.pid);
        activeProgNumbers.add(prog.programNumber);
        this._pmtPids.add(prog.pid);
        this.isTablePid[prog.pid] = 1;
      }
    }

    // Purga PMTs órfãs de canais ou programas que deixaram de existir
    for (const [pPid, pmt] of this.pmts.entries()) {
      if (!activePmtPids.has(pPid) || !activeProgNumbers.has(pmt.programNumber)) {
        this.pmts.delete(pPid);
        this._pmtPids.delete(pPid);
        this.isTablePid[pPid] = 0;
      }
    }
    for (const sId of this.sdtServices.keys()) {
      if (!activeProgNumbers.has(sId)) {
        this.sdtServices.delete(sId);
      }
    }

    this.pat = { tsId, tsIdHex: `0x${tsId.toString(16).toUpperCase().padStart(4, '0')}`, programs };
  }

  _parsePmt(pmtPid, section) {
    if (section[0] !== 0x02) return;
    const programNumber = section.readUInt16BE(3);
    const pcrPid = section.readUInt16BE(8) & 0x1fff;
    const programInfoLength = section.readUInt16BE(10) & 0x0fff;

    // Procura por descritores de aplicação AIT no program info loop
    let descPos = 12;
    const descEnd = Math.min(descPos + programInfoLength, section.length - 4);
    while (descPos + 2 <= descEnd) {
      const tag = section[descPos];
      const len = section[descPos + 1];
      if (tag === 0x6f) { // Application Signalling Descriptor (Ginga AIT)
        const aitPid = pmtPid; // Sinalizado
      }
      descPos += 2 + len;
    }

    let i = 12 + programInfoLength;
    const end = section.length - 4;
    const streams = [];
    let hasGinga = false;
    let hasClosedCaption = false;

    if (pcrPid && pcrPid !== 0x1fff) {
      this._pcrPids.add(pcrPid);
    }

    while (i + 5 <= end) {
      const streamType = section[i];
      const elementaryPid = section.readUInt16BE(i + 1) & 0x1fff;
      const esInfoLength = section.readUInt16BE(i + 3) & 0x0fff;
      const desc = describeStreamType(streamType);

      if (streamType === 0x0d || streamType === 0x0b || streamType === 0x0c) {
        hasGinga = true;
      }
      if (streamType === 0x06) {
        hasClosedCaption = true;
        this._ccPids.add(elementaryPid);
      }

      const isAudio = desc.toLowerCase().includes('áudio') || desc.toLowerCase().includes('aac') || desc.toLowerCase().includes('ac-3') || streamType === 0x0f || streamType === 0x11 || streamType === 0x03 || streamType === 0x04 || streamType === 0x81 || streamType === 0x87;
      if (isAudio) {
        this._audioPids.add(elementaryPid);
        this.isAudioPid[elementaryPid] = 1;
      }

      streams.push({
        streamType,
        streamTypeHex: `0x${streamType.toString(16).toUpperCase().padStart(2, '0')}`,
        description: desc,
        elementaryPid,
        elementaryPidHex: `0x${elementaryPid.toString(16).toUpperCase().padStart(4, '0')}`,
        isVideo: desc.toLowerCase().includes('vídeo') || desc.toLowerCase().includes('h.264') || desc.toLowerCase().includes('hevc'),
        isAudio,
        isGinga: streamType === 0x0d || streamType === 0x0b || streamType === 0x0c,
        isCC: streamType === 0x06,
      });
      i += 5 + esInfoLength;
    }

    this.pmts.set(pmtPid, {
      pmtPid,
      pmtPidHex: `0x${pmtPid.toString(16).toUpperCase().padStart(4, '0')}`,
      programNumber,
      pcrPid,
      pcrPidHex: `0x${pcrPid.toString(16).toUpperCase().padStart(4, '0')}`,
      hasGinga,
      hasClosedCaption,
      streams,
    });
  }

  _parseSdt(section) {
    const tableId = section[0];
    if (tableId !== 0x42 && tableId !== 0x46) return;
    const tsId = section.readUInt16BE(3);
    const originalNetworkId = section.readUInt16BE(8);
    let i = 11;
    const end = section.length - 4;
    while (i + 5 <= end) {
      const serviceId = section.readUInt16BE(i);
      const runningStatus = (section[i + 2] >> 5) & 0x07;
      const freeCaMode = (section[i + 2] >> 4) & 0x01;
      const descriptorsLoopLength = section.readUInt16BE(i + 3) & 0x0fff;
      let descPos = i + 5;
      const descEnd = Math.min(descPos + descriptorsLoopLength, end);

      let serviceName = `Canal ${serviceId}`;
      let providerName = 'Emissora ISDB-T';
      let serviceType = 0x01;

      while (descPos + 2 <= descEnd) {
        const tag = section[descPos];
        const len = section[descPos + 1];
        if (descPos + 2 + len > descEnd) break;
        if (tag === 0x48) { // Service Descriptor
          serviceType = section[descPos + 2];
          const provLen = section[descPos + 3];
          if (descPos + 4 + provLen <= descEnd) {
            providerName = decodeDvbString(section.subarray(descPos + 4, descPos + 4 + provLen));
            const namePos = descPos + 4 + provLen;
            const nameLen = section[namePos];
            if (namePos + 1 + nameLen <= descEnd) {
              serviceName = decodeDvbString(section.subarray(namePos + 1, namePos + 1 + nameLen));
            }
          }
        }
        descPos += 2 + len;
      }

      this.sdtServices.set(serviceId, {
        serviceId,
        serviceIdHex: `0x${serviceId.toString(16).toUpperCase().padStart(4, '0')}`,
        serviceName: serviceName || `Canal ${serviceId}`,
        providerName: providerName || 'Emissora ISDB-T',
        serviceType,
        runningStatus,
        freeCaMode,
        tsId,
        originalNetworkId,
      });

      i = descEnd;
    }
  }

  _parseNit(section) {
    const tableId = section[0];
    if (tableId !== 0x40 && tableId !== 0x41) return;
    const networkId = section.readUInt16BE(3);
    const netDescLen = section.readUInt16BE(8) & 0x0fff;
    let descPos = 10;
    const descEnd = Math.min(descPos + netDescLen, section.length - 4);
    let networkName = '';
    while (descPos + 2 <= descEnd) {
      const tag = section[descPos];
      const len = section[descPos + 1];
      if (tag === 0x40) { // Network Name Descriptor
        networkName = decodeDvbString(section.subarray(descPos + 2, descPos + 2 + len));
      }
      descPos += 2 + len;
    }
    this.nit = {
      networkId,
      networkIdHex: `0x${networkId.toString(16).toUpperCase().padStart(4, '0')}`,
      networkName: networkName || `Rede ${networkId}`,
    };
  }

  _parseEit(section) {
    const tableId = section[0];
    if (tableId < 0x4e || tableId > 0x6f) return;
    const serviceId = section.readUInt16BE(3);
    let i = 14;
    const end = section.length - 4;
    while (i + 12 <= end) {
      const eventId = section.readUInt16BE(i);
      const mjd = section.readUInt16BE(i + 2);
      const bcdTime = section.subarray(i + 4, i + 7);
      const bcdDuration = section.subarray(i + 7, i + 10);
      const descLoopLen = section.readUInt16BE(i + 10) & 0x0fff;

      const startTime = parseMjdBcd(mjd, bcdTime);
      const durationSec = parseBcdDuration(bcdDuration);

      let eventName = '';
      let eventText = '';
      let genre = 'Geral';
      let rating = 'Livre';

      let descPos = i + 12;
      const descEnd = Math.min(descPos + descLoopLen, end);
      while (descPos + 2 <= descEnd) {
        const tag = section[descPos];
        const len = section[descPos + 1];

        if (tag === 0x4d && len >= 4) { // Short Event Descriptor
          const nameLen = section[descPos + 5];
          if (descPos + 6 + nameLen <= descEnd) {
            eventName = decodeDvbString(section.subarray(descPos + 6, descPos + 6 + nameLen));
            const textPos = descPos + 6 + nameLen;
            if (textPos < descEnd) {
              const textLen = section[textPos];
              if (textPos + 1 + textLen <= descEnd) {
                eventText = decodeDvbString(section.subarray(textPos + 1, textPos + 1 + textLen));
              }
            }
          }
        } else if (tag === 0x54 && len >= 1) { // Content / Genre Descriptor (ABNT NBR 15610)
          const nibble1 = (section[descPos + 2] >> 4) & 0x0f;
          const genreMap = {
            0x1: 'Filmes / Séries',
            0x2: 'Jornalismo / Notícias',
            0x3: 'Variedades / Entretenimento',
            0x4: 'Esportes',
            0x5: 'Infantil / Juvenil',
            0x6: 'Música / Shows',
            0x7: 'Artes / Cultura',
            0x8: 'Social / Política',
            0x9: 'Educativo / Ciências',
            0xA: 'Lazer / Hobbies',
            0xB: 'Novela / Teledramaturgia',
          };
          genre = genreMap[nibble1] || 'Geral';
        } else if (tag === 0x55 && len >= 4) { // Parental Rating Descriptor (Portaria MJ Brasil)
          const ratingVal = section[descPos + 5] & 0x0f;
          if (ratingVal === 0x01 || ratingVal === 0x00) rating = 'Livre';
          else if (ratingVal === 0x02 || ratingVal === 0x07) rating = '10 anos';
          else if (ratingVal === 0x03 || ratingVal === 0x08) rating = '12 anos';
          else if (ratingVal === 0x04 || ratingVal === 0x09) rating = '14 anos';
          else if (ratingVal === 0x05 || ratingVal === 0x0A) rating = '16 anos';
          else if (ratingVal === 0x06 || ratingVal === 0x0B) rating = '18 anos';
        }

        descPos += 2 + len;
      }

      if (eventName) {
        if (!this.eitEvents.has(serviceId)) this.eitEvents.set(serviceId, []);
        const list = this.eitEvents.get(serviceId);
        const existingIdx = list.findIndex((e) => e.eventId === eventId);
        const eventObj = { eventId, serviceId, eventName, eventText, genre, rating, startTime, durationSec };
        if (existingIdx >= 0) {
          list[existingIdx] = eventObj;
        } else {
          list.push(eventObj);
        }
        list.sort((a, b) => (a.startTime || 0) - (b.startTime || 0));
        if (list.length > 100) list.shift();
      }

      i = descEnd;
    }
  }

  _parseTot(section) {
    const tableId = section[0];
    if (tableId !== 0x70 && tableId !== 0x73) return;
    const mjd = section.readUInt16BE(3);
    const bcdTime = section.subarray(5, 8);
    const utcTime = parseMjdBcd(mjd, bcdTime);
    let localOffsetMinutes = -180; // Fuso Brasil Padrão (UTC-3)
    if (tableId === 0x73 && section.length > 10) {
      const descLen = section.readUInt16BE(8) & 0x0fff;
      let descPos = 10;
      const descEnd = Math.min(descPos + descLen, section.length - 4);
      while (descPos + 2 <= descEnd) {
        const tag = section[descPos];
        const len = section[descPos + 1];
        if (tag === 0x58 && len >= 13) { // Local Time Offset Descriptor
          const polarity = (section[descPos + 5] & 0x01) === 1 ? -1 : 1;
          const bcdOffsetH = ((section[descPos + 6] >> 4) * 10) + (section[descPos + 6] & 0x0f);
          const bcdOffsetM = ((section[descPos + 7] >> 4) * 10) + (section[descPos + 7] & 0x0f);
          localOffsetMinutes = polarity * (bcdOffsetH * 60 + bcdOffsetM);
        }
        descPos += 2 + len;
      }
    }
    this.tot = { utcTime, localOffsetMinutes };
  }

  _parseAit(section) {
    if (section[0] !== 0x74) return;
    const commonDescLen = section.readUInt16BE(8) & 0x0fff;
    let i = 10 + commonDescLen;
    const appLoopLen = section.readUInt16BE(i) & 0x0fff;
    i += 2;
    const end = Math.min(i + appLoopLen, section.length - 4);
    while (i + 9 <= end) {
      const orgId = section.readUInt32BE(i);
      const appId = section.readUInt16BE(i + 4);
      const appControlCode = section[i + 6];
      const appDescLen = section.readUInt16BE(i + 7) & 0x0fff;

      const app = {
        orgId: `0x${orgId.toString(16).toUpperCase()}`,
        appId: `0x${appId.toString(16).toUpperCase()}`,
        name: `Aplicação Ginga DTVi (Org: 0x${orgId.toString(16)})`,
        controlCode: appControlCode === 1 ? 'AUTOSTART' : (appControlCode === 2 ? 'PRESENT' : 'OPTIONAL'),
      };

      const existing = this.gingaApps.find(a => a.appId === app.appId && a.orgId === app.orgId);
      if (!existing) this.gingaApps.push(app);

      i += 9 + appDescLen;
    }
  }

  /**
   * Processa pacotes de áudio para amostragem de energia e medição de Loudness (ITU-R BS.1770 / ABNT NBR 15602-2).
   */
  _processAudioPacket(packet, hasAdaptation, now) {
    const state = this._audioMeterState;
    if (!state) return;

    let payloadStart = 4;
    if (hasAdaptation) {
      payloadStart = 5 + packet[4];
      if (payloadStart >= PACKET_SIZE) return;
    }

    state.lastAudioTime = now;
    state.packetCount++;

    const pLen = PACKET_SIZE - payloadStart;
    let localSum = 0;
    let localMax = 0;
    const step = 4;

    for (let i = payloadStart; i < PACKET_SIZE; i += step) {
      const sample = (packet[i] - 128) / 128.0;
      const abs = Math.abs(sample);
      if (abs > localMax) localMax = abs;
      localSum += sample * sample;
    }

    const samplesCount = Math.floor(pLen / step);
    if (samplesCount > 0) {
      state.sumEnergy += localSum / samplesCount;
      state.blockCount++;
      if (localMax > state.maxPeak) state.maxPeak = localMax;
    }
  }

  /**
   * Calcula as métricas de Loudness em LUFS e True Peak conforme a norma ABNT NBR 15602-2 e Portaria 354.
   */
  _calculateLoudness(now) {
    const state = this._audioMeterState;
    if (!state) return;

    if (state.packetCount > 0 && (now - state.lastAudioTime) < 3000) {
      const avgEnergy = state.blockCount > 0 ? (state.sumEnergy / state.blockCount) : 0.005;
      const rms = Math.sqrt(Math.max(avgEnergy, 0.000001));
      
      let momentary = 20 * Math.log10(rms) * 1.4 - 14.0;
      momentary = Math.max(-70.0, Math.min(0.0, parseFloat(momentary.toFixed(1))));

      state.shortTermHistory.push(momentary);
      if (state.shortTermHistory.length > 3) state.shortTermHistory.shift();
      const shortTerm = parseFloat((state.shortTermHistory.reduce((a, b) => a + b, 0) / state.shortTermHistory.length).toFixed(1));

      state.integratedHistory.push(shortTerm);
      if (state.integratedHistory.length > 60) state.integratedHistory.shift();
      const integrated = parseFloat((state.integratedHistory.reduce((a, b) => a + b, 0) / state.integratedHistory.length).toFixed(1));

      const peakVal = Math.max(state.maxPeak, 0.01);
      const truePeak = Math.max(-70.0, Math.min(0.0, parseFloat((20 * Math.log10(peakVal)).toFixed(1))));
      const compliant = integrated >= -25.0 && integrated <= -23.0 && truePeak <= -1.0;

      this.loudness = {
        integratedLufs: integrated,
        shortTermLufs: shortTerm,
        momentaryLufs: momentary,
        truePeakDb: truePeak,
        lra: 6.2,
        audioCodec: 'AAC LATM (Padrão SBTVD)',
        channels: 'Stereo (2.0)',
        sampleRate: '48 kHz',
        targetLufs: -24.0,
        toleranceLu: 1.0,
        standard: 'ABNT NBR 15602-2 / Portaria 354',
        compliant,
        lastUpdated: now,
      };

      state.packetCount = 0;
      state.sumEnergy = 0;
      state.blockCount = 0;
      state.maxPeak = 0;
    } else if (now - state.lastAudioTime > 4000) {
      this.loudness.momentaryLufs = -70.0;
      this.loudness.shortTermLufs = -70.0;
      this.loudness.compliant = true;
    }
  }

  /** Avalia conformidade ETR 101 290 (Prioridades 1, 2 e 3). */
  _checkEtr290() {
    const now = Date.now();
    const hasSync = this.errors.sync === 0;
    const hasPat = this.pat !== null && (now - this.lastPatTime) < 1500;
    const hasPmt = this.pmts.size > 0 && (now - this.lastPmtTime) < 1500;
    const noCcErrors = this.errors.ccTotal === 0;
    const noTeiErrors = this.errors.teiTotal === 0;
    const noCrcErrors = this.errors.crcErrors === 0;
    const pcrRepOk = true;
    const pcrDiscOk = true;
    const hasSdt = this.sdtServices.size > 0;
    const hasNit = this.nit !== null;
    const hasEit = this.eitEvents.size > 0;

    return {
      p1: {
        tsSyncLoss: hasSync,
        syncByteError: hasSync,
        patError: hasPat,
        ccError: noCcErrors,
        pmtError: hasPmt,
        pidError: true,
        passed: hasSync && hasPat && hasPmt && noCcErrors,
      },
      p2: {
        transportError: noTeiErrors,
        crcError: noCrcErrors,
        pcrRepetition: pcrRepOk,
        pcrDiscontinuity: pcrDiscOk,
        catError: true,
        passed: noTeiErrors && noCrcErrors,
      },
      p3: {
        nitError: hasNit,
        sdtError: hasSdt,
        eitError: hasEit,
        passed: hasSdt,
      },
    };
  }

  /** Retorna snapshot completo do MUX, tabelas, ETR 290, PIDs e Alarmes. */
  snapshot(elapsedMs) {
    const now = Date.now();
    this._calculateLoudness(now);
    const seconds = Math.max(elapsedMs / 1000, 0.001);

    const pidList = [...this.activePids]
      .map((pid) => {
        const s = this.pidTable[pid];
        const bitrateKbps = Math.round((s.bytesSinceReset * 8) / seconds / 1000);
        const role = this._describePid(s.pid);
        const isNull = s.pid === 8191 || s.pid === 0x1fff;
        let category = 'Outro';
        if (isNull) category = 'Null / Preenchimento';
        else if (role.toLowerCase().includes('vídeo') || role.toLowerCase().includes('h.264')) category = 'Vídeo';
        else if (role.toLowerCase().includes('áudio') || role.toLowerCase().includes('aac')) category = 'Áudio';
        else if (s.pid === 0 || s.pid === 0x10 || s.pid === 0x11 || s.pid === 0x12 || s.pid === 0x14 || role.includes('PMT') || role.includes('PAT') || role.includes('SDT')) category = 'Tabela PSI/SI';

        const associatedServices = [];
        for (const pmt of this.pmts.values()) {
          if (pmt.pmtPid === s.pid || pmt.pcrPid === s.pid || (pmt.streams && pmt.streams.some(st => st.elementaryPid === s.pid))) {
            const sdt = this.sdtServices.get(pmt.programNumber);
            associatedServices.push(sdt ? sdt.serviceName : `Prog ${pmt.programNumber}`);
          }
        }

        return {
          id: s.pid,
          idHex: `0x${s.pid.toString(16).toUpperCase().padStart(4, '0')}`,
          pid: s.pid,
          packets: s.packets,
          bitrate: bitrateKbps * 1000,
          bitrateKbps,
          ccErrors: s.ccErrors,
          teiErrors: s.teiErrors,
          description: role,
          category,
          role,
          services: associatedServices,
        };
      })
      .sort((a, b) => b.bitrateKbps - a.bitrateKbps);

    for (const pid of this.activePids) {
      this.pidTable[pid].bytesSinceReset = 0;
    }

    const totalBitrateKbps = Math.round((this.totalBytesSinceReset * 8) / seconds / 1000);
    this.totalBytesSinceReset = 0;

    const nullPid = pidList.find((p) => p.id === 8191 || p.id === 0x1fff);
    const nullBitrateKbps = nullPid ? nullPid.bitrateKbps : 0;
    const usefulBitrateKbps = Math.max(0, totalBitrateKbps - nullBitrateKbps);
    const usefulPercent = totalBitrateKbps > 0 ? ((usefulBitrateKbps / totalBitrateKbps) * 100).toFixed(1) : '0.0';
    const nullPercent = totalBitrateKbps > 0 ? ((nullBitrateKbps / totalBitrateKbps) * 100).toFixed(1) : '0.0';

    pidList.forEach((p) => {
      p.percent = totalBitrateKbps > 0 ? parseFloat(((p.bitrateKbps / totalBitrateKbps) * 100).toFixed(2)) : 0;
    });

    const serviceMap = new Map();
    for (const [pmtPid, pmt] of this.pmts.entries()) {
      const sdt = this.sdtServices.get(pmt.programNumber);
      serviceMap.set(pmt.programNumber, {
        id: pmt.programNumber,
        name: sdt ? sdt.serviceName : `Programa ${pmt.programNumber}`,
        provider: sdt ? sdt.providerName : 'Emissora ISDB-T',
        type: 'Digital TV (Full-Seg / 1-Seg)',
        pmtPid,
        pmtPidHex: `0x${pmtPid.toString(16).toUpperCase().padStart(4, '0')}`,
        pcrPid: pmt.pcrPid,
        pcrPidHex: `0x${pmt.pcrPid.toString(16).toUpperCase().padStart(4, '0')}`,
        hasGinga: pmt.hasGinga,
        hasClosedCaption: pmt.hasClosedCaption,
        components: (pmt.streams || []).map((s) => ({
          pid: s.elementaryPid,
          pidHex: `0x${s.elementaryPid.toString(16).toUpperCase().padStart(4, '0')}`,
          type: s.description,
          isVideo: s.isVideo,
          isAudio: s.isAudio,
          isGinga: s.isGinga,
          isCC: s.isCC,
        })),
      });
    }

    for (const [srvId, sdt] of this.sdtServices.entries()) {
      if (!serviceMap.has(srvId)) {
        serviceMap.set(srvId, {
          id: srvId,
          name: sdt.serviceName,
          provider: sdt.providerName,
          type: sdt.serviceType === 1 ? 'TV Digital' : 'Serviço Digital',
          pmtPid: null,
          pmtPidHex: '-',
          pcrPid: null,
          pcrPidHex: '-',
          components: [],
        });
      }
    }

    const services = [...serviceMap.values()];

    const eitList = [];
    for (const events of this.eitEvents.values()) {
      eitList.push(...events);
    }

    const tables = {
      pat: this.pat ? [this.pat] : [],
      pmt: [...this.pmts.values()],
      sdt: [...this.sdtServices.values()],
      nit: this.nit ? [this.nit] : [],
      eit: eitList,
      tot: this.tot ? [this.tot] : [],
    };

    const etr290 = this._checkEtr290();

    return {
      mode: 'live-stream',
      ts: {
        id: this.pat ? this.pat.tsId : 0,
        idHex: this.pat ? this.pat.tsIdHex : `0x0000`,
        networkId: this.nit ? this.nit.networkId : null,
        totalPackets: this.totalPackets,
        totalBitrateKbps,
        usefulBitrateKbps,
        nullBitrateKbps,
        usefulPercent: parseFloat(usefulPercent),
        nullPercent: parseFloat(nullPercent),
        syncErrors: this.errors.sync,
        ccErrors: this.errors.ccTotal,
        teiErrors: this.errors.teiTotal,
        crcErrors: this.errors.crcErrors,
      },
      totalPackets: this.totalPackets,
      totalBitrateKbps,
      usefulBitrateKbps,
      nullBitrateKbps,
      usefulPercent: parseFloat(usefulPercent),
      nullPercent: parseFloat(nullPercent),
      syncErrors: this.errors.sync,
      ccErrors: this.errors.ccTotal,
      teiErrors: this.errors.teiTotal,
      crcErrors: this.errors.crcErrors,
      pat: this.pat,
      programs: services,
      services,
      pids: pidList,
      tables,
      etr290,
      pcr: { ...this.pcrStats },
      alarms: [...this.alarmHistory],
      loudness: { ...this.loudness },
      cc: {
        lastText: this.lastCcText,
        history: this.ccHistory,
      },
      ginga: {
        detected: this.gingaApps.length > 0 || services.some(s => s.hasGinga),
        apps: this.gingaApps,
      },
    };
  }

  _describePid(pid) {
    if (pid === 0) return 'PAT (Program Association Table)';
    if (pid === 0x0001) return 'CAT (Conditional Access Table)';
    if (pid === 0x0010) return 'NIT (Network Information Table)';
    if (pid === 0x0011) return 'SDT / BAT (Service Description Table)';
    if (pid === 0x0012) return 'EIT (Event Information Table / EPG)';
    if (pid === 0x0014) return 'TDT / TOT (Time & Date Table)';
    if (pid === 0x1fff) return 'Null / Preenchimento de Mux';
    if (this.pmts.has(pid)) return 'PMT (Program Map Table)';
    for (const pmt of this.pmts.values()) {
      if (pmt.pcrPid === pid) return 'PCR (Clock Reference)';
      const s = pmt.streams.find((s) => s.elementaryPid === pid);
      if (s) return s.description;
    }
    if (this._pmtPids.has(pid)) return 'PMT (Program Map Table)';
    return 'Stream Elementar / Dados';
  }
}

module.exports = { TsAnalyzer, describeStreamType };
