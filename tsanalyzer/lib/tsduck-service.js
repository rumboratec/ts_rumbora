'use strict';

const { spawn, exec } = require('child_process');
const path = require('path');
const fs = require('fs');

/**
 * Utilitário resiliente para verificar a presença de ferramentas externas no sistema
 */
function checkTool(cmd) {
  return new Promise((resolve) => {
    exec(`${cmd} -version`, { env: process.env, timeout: 3000 }, (err) => {
      if (!err) return resolve(true);

      exec(`${cmd} --help`, { env: process.env, timeout: 3000 }, (err2) => {
        if (!err2) return resolve(true);

        const standardPaths = [
          `/usr/bin/${cmd}`,
          `/usr/local/bin/${cmd}`,
          `/bin/${cmd}`,
          `/snap/bin/${cmd}`,
          `C:\\ffmpeg\\bin\\${cmd}.exe`,
          `C:\\Program Files\\TSDuck\\bin\\${cmd}.exe`,
        ];

        for (const p of standardPaths) {
          if (fs.existsSync(p)) return resolve(true);
        }

        resolve(false);
      });
    });
  });
}

async function checkEnvironment() {
  const [hasTsanalyze, hasTstables, hasTsp, hasFfmpeg, hasDvbZap] = await Promise.all([
    checkTool('tsanalyze'),
    checkTool('tstables'),
    checkTool('tsp'),
    checkTool('ffmpeg'),
    checkTool('dvbv5-zap'),
  ]);

  return {
    tsduck: hasTsanalyze && hasTstables,
    tsanalyze: hasTsanalyze,
    tstables: hasTstables,
    tsp: hasTsp,
    ffmpeg: hasFfmpeg,
    dvbv5zap: hasDvbZap,
  };
}

/**
 * Executa o comando tsanalyze em um arquivo e retorna o JSON estruturado
 */
function analyzeFileWithTsDuck(filePath) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(filePath)) {
      return reject(new Error(`Arquivo não encontrado: ${filePath}`));
    }

    const args = [filePath, '--json'];
    const proc = spawn('tsanalyze', args);

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('error', (err) => {
      reject(new Error(`Falha ao executar tsanalyze: ${err.message}. Verifique se o TSDuck está instalado.`));
    });

    proc.on('close', (code) => {
      if (code !== 0 && !stdout.trim()) {
        return reject(new Error(`tsanalyze encerrou com código ${code}: ${stderr}`));
      }

      try {
        const json = JSON.parse(stdout);
        resolve(normalizeTsAnalyzeJson(json));
      } catch (e) {
        reject(new Error(`Falha ao fazer parse do JSON do tsanalyze: ${e.message}\nSaída: ${stdout.slice(0, 300)}`));
      }
    });
  });
}

/**
 * Executa o comando tstables para extrair todas as seções e tabelas em JSON
 */
function dumpTablesWithTsDuck(filePath) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(filePath)) {
      return reject(new Error(`Arquivo não encontrado: ${filePath}`));
    }

    const args = [filePath, '--json', '--all-sections'];
    const proc = spawn('tstables', args);

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('error', (err) => {
      reject(new Error(`Falha ao executar tstables: ${err.message}`));
    });

    proc.on('close', (code) => {
      if (code !== 0 && !stdout.trim()) {
        return resolve({ raw: stderr, parsedTables: {} });
      }

      try {
        const json = JSON.parse(stdout);
        resolve({ raw: null, parsedTables: normalizeTsTablesJson(json) });
      } catch (e) {
        resolve({ raw: stdout, parsedTables: { rawText: stdout } });
      }
    });
  });
}

/**
 * Normaliza e enriquece a saída de tsanalyze e tsp analyze
 */
function normalizeTsAnalyzeJson(raw) {
  const ts = raw.ts || {};
  const pidsRaw = raw.pids || [];
  const servicesRaw = raw.services || [];
  const tablesRaw = raw.tables || [];

  const totalBitrate = ts.bitrate || 0;
  const totalPackets = ts.packets || 0;

  const pids = pidsRaw.map((p) => {
    const pidVal = p.id !== undefined ? p.id : 0;
    const isNull = pidVal === 8191 || pidVal === 0x1fff;
    const bitrate = p.bitrate || 0;
    const percent = totalBitrate > 0 ? ((bitrate / totalBitrate) * 100).toFixed(2) : '0.00';

    let category = 'Outro';
    const desc = p.description || '';
    if (isNull) category = 'Null / Preenchimento';
    else if (p.audio || desc.toLowerCase().includes('audio') || desc.toLowerCase().includes('aac') || desc.toLowerCase().includes('ac-3')) category = 'Áudio';
    else if (p.video || desc.toLowerCase().includes('video') || desc.toLowerCase().includes('avc') || desc.toLowerCase().includes('hevc') || desc.toLowerCase().includes('h.264')) category = 'Vídeo';
    else if (p.pmt || desc.toLowerCase().includes('pmt')) category = 'PMT';
    else if (pidVal === 0 || desc.toLowerCase().includes('pat')) category = 'PAT';
    else if (pidVal === 0x0011 || desc.toLowerCase().includes('sdt')) category = 'SDT';
    else if (pidVal === 0x0010 || desc.toLowerCase().includes('nit')) category = 'NIT';
    else if (pidVal === 0x0012 || desc.toLowerCase().includes('eit')) category = 'EIT (EPG)';
    else if (pidVal === 0x0014 || desc.toLowerCase().includes('tot') || desc.toLowerCase().includes('tdt')) category = 'TDT/TOT';
    else if (desc.toLowerCase().includes('table') || desc.toLowerCase().includes('psi') || desc.toLowerCase().includes('si')) category = 'Tabela PSI/SI';

    return {
      id: pidVal,
      idHex: `0x${pidVal.toString(16).toUpperCase().padStart(4, '0')}`,
      description: desc || category,
      category,
      packets: p.packets || 0,
      bitrate: bitrate,
      bitrateKbps: Math.round(bitrate / 1000),
      percent: parseFloat(percent),
      isScrambled: !!p.scrambled,
      isPmt: !!p.pmt,
      isPcr: !!p.pcr,
      services: (p.services || []).map((s) => (typeof s === 'object' ? (s.name || `Prog ${s.id}`) : s)),
    };
  });

  pids.sort((a, b) => b.bitrate - a.bitrate);

  const nullPid = pids.find((p) => p.id === 8191 || p.id === 0x1fff);
  const nullBitrate = nullPid ? nullPid.bitrate : 0;
  const usefulBitrate = Math.max(0, totalBitrate - nullBitrate);
  const usefulPercent = totalBitrate > 0 ? ((usefulBitrate / totalBitrate) * 100).toFixed(1) : '0.0';
  const nullPercent = totalBitrate > 0 ? ((nullBitrate / totalBitrate) * 100).toFixed(1) : '0.0';

  const services = servicesRaw.map((s) => ({
    id: s.id,
    name: s.name || `Canal ${s.id}`,
    provider: s.provider || 'Emissora ISDB-T',
    type: s.type_name || s.type || 'Digital TV',
    pmtPid: s.pmt_pid,
    pmtPidHex: s.pmt_pid !== undefined ? `0x${s.pmt_pid.toString(16).toUpperCase().padStart(4, '0')}` : '-',
    pcrPid: s.pcr_pid,
    pcrPidHex: s.pcr_pid !== undefined ? `0x${s.pcr_pid.toString(16).toUpperCase().padStart(4, '0')}` : '-',
    bitrate: s.bitrate || 0,
    bitrateKbps: Math.round((s.bitrate || 0) / 1000),
    components: (s.components || []).map((c) => ({
      pid: c.pid,
      pidHex: `0x${(c.pid || 0).toString(16).toUpperCase().padStart(4, '0')}`,
      type: c.type_name || c.type || 'Desconhecido',
      language: c.language || null,
      bitrate: c.bitrate || 0,
      bitrateKbps: Math.round((c.bitrate || 0) / 1000),
      isAudio: !!c.audio || (c.type_name && c.type_name.toLowerCase().includes('audio')),
      isVideo: !!c.video || (c.type_name && (c.type_name.toLowerCase().includes('video') || c.type_name.toLowerCase().includes('avc'))),
    })),
  }));

  // Constrói tabelas amigáveis a partir do resumo do TSDuck
  const sdtTables = services.map(s => ({
    serviceId: s.id,
    serviceIdHex: `0x${s.id.toString(16).toUpperCase().padStart(4, '0')}`,
    serviceName: s.name,
    providerName: s.provider,
    serviceType: s.type,
    runningStatus: 4,
  }));

  const patTables = [{
    tsId: ts.id || 0,
    programs: services.map(s => ({ programNumber: s.id, pid: s.pmtPid })),
  }];

  const pmtTables = services.map(s => ({
    programNumber: s.id,
    pmtPid: s.pmt_pid,
    pcrPid: s.pcr_pid,
    streams: s.components.map(c => ({
      streamType: c.type,
      description: c.type,
      elementaryPid: c.pid,
      isVideo: c.isVideo,
      isAudio: c.isAudio,
    })),
  }));

  const tables = {
    pat: patTables,
    pmt: pmtTables,
    sdt: sdtTables,
    nit: ts.original_network_id ? [{ networkId: ts.original_network_id, networkName: 'Rede Digital' }] : [],
    eit: [],
    tot: [],
  };

  return {
    mode: 'tsduck',
    ts: {
      id: ts.id || 0,
      idHex: `0x${(ts.id || 0).toString(16).toUpperCase().padStart(4, '0')}`,
      networkId: ts.original_network_id || ts.network_id || null,
      totalPackets,
      totalBitrateKbps: Math.round(totalBitrate / 1000),
      usefulBitrateKbps: Math.round(usefulBitrate / 1000),
      nullBitrateKbps: Math.round(nullBitrate / 1000),
      usefulPercent: parseFloat(usefulPercent),
      nullPercent: parseFloat(nullPercent),
      packetSize: ts.packet_size || 188,
      durationSeconds: ts.duration || null,
      syncErrors: 0,
    },
    pids,
    services,
    tablesSummary: tablesRaw,
    tables,
    raw,
  };
}

/**
 * Normaliza as tabelas obtidas de tstables
 */
function normalizeTsTablesJson(json) {
  const result = {
    pat: [],
    pmt: [],
    sdt: [],
    nit: [],
    eit: [],
    tot: [],
    tdt: [],
    cat: [],
    ait: [],
    others: [],
  };

  const sections = Array.isArray(json) ? json : (json['#nodes'] || [json]);

  for (const node of sections) {
    if (!node || typeof node !== 'object') continue;

    const keys = Object.keys(node);
    for (const key of keys) {
      const lower = key.toLowerCase();
      const tableData = node[key];

      if (lower === 'pat') result.pat.push(tableData);
      else if (lower === 'pmt') result.pmt.push(tableData);
      else if (lower === 'sdt') result.sdt.push(tableData);
      else if (lower === 'nit') result.nit.push(tableData);
      else if (lower === 'eit') result.eit.push(tableData);
      else if (lower === 'tot') result.tot.push(tableData);
      else if (lower === 'tdt') result.tdt.push(tableData);
      else if (lower === 'cat') result.cat.push(tableData);
      else if (lower === 'ait') result.ait.push(tableData);
      else if (lower !== '#nodes' && lower !== '#comment') {
        result.others.push({ table: key, data: tableData });
      }
    }
  }

  return result;
}

/**
 * Extrai 1 frame JPEG a partir de um arquivo .ts usando FFmpeg
 */
function extractFrameFromFile(tsFilePath, outJpgPath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-threads', '1',
      '-skip_frame', 'nokey',
      '-discard', 'nokey',
      '-an', '-sn', '-dn',
      '-y',
      '-i', tsFilePath,
      '-vf', 'scale=640:-2',
      '-frames:v', '1',
      '-q:v', '5',
      outJpgPath,
    ];

    const proc = spawn('ffmpeg', args);
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (err) => reject(err));
    proc.on('close', (code) => {
      if (code === 0 && fs.existsSync(outJpgPath)) {
        resolve(outJpgPath);
      } else {
        const fallbackArgs = [
          '-hide_banner', '-loglevel', 'error',
          '-threads', '1',
          '-y',
          '-analyzeduration', '2000000',
          '-probesize', '2000000',
          '-i', tsFilePath,
          '-vf', 'scale=640:-2',
          '-vframes', '1',
          '-q:v', '5',
          outJpgPath,
        ];
        const fbProc = spawn('ffmpeg', fallbackArgs);
        fbProc.on('close', (fbCode) => {
          if (fbCode === 0 && fs.existsSync(outJpgPath)) resolve(outJpgPath);
          else reject(new Error(`FFmpeg falhou ao extrair frame (code ${code}): ${stderr}`));
        });
      }
    });
  });
}

module.exports = {
  checkEnvironment,
  analyzeFileWithTsDuck,
  dumpTablesWithTsDuck,
  extractFrameFromFile,
  normalizeTsAnalyzeJson,
  normalizeTsTablesJson,
};
