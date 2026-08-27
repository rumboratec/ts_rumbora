# 📡 TS Analyzer Pro — ISDB-T (SBTVD) & DVB Broadcast Suite

> Sistema profissional de alta performance para monitoramento, análise de conformidade **ETR 101 290**, medição de **Loudness (ABNT NBR 15602-2)**, decodificação de **Closed Caption**, **EPG** e integração em tempo real com **Grafana** e **Prometheus**.

---

## 🚀 Recursos Principais

### 1. 📊 Análise de MUX & Mapeamento de PIDs
- **Distribuição de Banda**: Bitrate total, útil vs nulo (`0x1FFF` padding / stuffing), ocupação percentual e taxa de pacotes por segundo.
- **Tabela Interativa de PIDs**: Filtros dinâmicos (Vídeo, Áudio, PSI/SI, Null), busca instantânea, ordenação e identificação de codecs (H.264, H.265/HEVC, AAC LATM/ADTS, AC-3).
- **Contadores de Erro**: Rastreamento em tempo real de saltos de continuidade (*Continuity Counter - CC*) e indicadores de erro de transporte (*TEI*).

### 2. 🛡️ Conformidade ETR 101 290 (Prioridades 1, 2 e 3)
- **Prioridade 1 (P1)**: *TS Sync Loss*, *Sync Byte Error* (`0x47`), *PAT Error*, *Continuity Count Error*, *PMT Error*, *PID Error*.
- **Prioridade 2 (P2)**: *Transport Error Indicator (TEI)*, **Validação Real de CRC32** para tabelas PSI/SI, *PCR Repetition Delta* ($\le 40\text{ ms}$), *PCR Discontinuity / Jitter* (em nanossegundos) e *CAT Error*.
- **Prioridade 3 (P3)**: *NIT Error*, *SDT Error*, *EIT Error*.
- **Histórico & Log de Alarmes**: Ring-buffer em tempo real com debounce, filtragem por severidade (P1, P2, P3, RF) e exportação em CSV.

### 3. 🔊 Medição de Áudio & Loudness (ABNT NBR 15602-2 / Portaria 354)
- Telemetria contínua de áudio conforme as normas do **SBTVD** e **ITU-R BS.1770**:
  - **Integrated Loudness** (alvo nominal: $-24.0 \pm 1.0\text{ LUFS}$)
  - **Short-Term Loudness** (janela móvel de 3s)
  - **Momentary Loudness**
  - **True Peak** ($\le -1.0\text{ dBTP}$)
  - **LRA** (*Loudness Range*)
  - Selo automático de conformidade legal.

### 4. 📺 Closed Caption & Interatividade Ginga
- **Closed Caption ABNT NBR 15610 / ARIB STD-B24**: Decodificador determinístico em tempo real com filtragem de caracteres de escape CSI/ARIB e exibição em overlay sobre o vídeo.
- **Ginga DTVi (DSM-CC / AIT)**: Identificação de carrossel de dados e aplicações interativas com Organization ID e Application ID.

### 5. 📅 Guia Eletrônico de Programação (EPG / EIT)
- **Linha do Tempo Dinâmica**: Grade visual "No Ar" e "A Seguir" com barra de progresso em tempo real e atualização contínua de eventos EIT.
- **Visualização em Lista**: Tabela paginada com títulos, sinopses, início, duração e classificação indicativa.
- Limpeza e troca automática de dados ao mudar de canal.

### 6. 📻 Sintonizador Físico UHF & Varredura Rápida
- **Canais UHF 14 a 69**: Cálculo automático de frequência central e sintonia direta via Linux DVB API.
- **Varredura Inteligente (Fast-Probe)**: Varre todo o espectro UHF em segundos, detectando portadoras ativas, medição de SNR/Sinal e identificando emissoras via SDT.
- **Watchdog de Recuperação Automática**: Reconexão imediata do sintonizador em caso de oscilações de sinal.

### 7. 🌐 Integração Nativa com Grafana & Prometheus
- **Prometheus Exporter (`/metrics`)**: Métricas de MUX, taxas de bitrate, erros ETR 290, Loudness LUFS, PCR Jitter e telemetria RF prontas para scraping.
- **JSON REST API (`/api/metrics/json`)**: Endpoint em tempo real compatível com o plugin *Grafana Infinity* ou *JSON API*.
- **Configuração Persistente da API JSON**: Modal interativo (`⚙️ Configurar API JSON`) para habilitar/desabilitar quais campos técnicos serão expostos, salvo permanentemente no servidor.

### 8. 📄 Exportação de Diagnósticos e Gravação de Amostras
- **Laudo Técnico Formal (PDF)** com gráficos de conformidade, PIDs e carimbo de data/hora.
- **Diagnóstico Completo em JSON** para suporte técnico avançado.
- **Gravador de Amostras .TS**: Captura sob demanda de arquivos brutos de 1 a 5 minutos (armazenamento de até 5 amostras) para auditoria.

---

## 🏗️ Arquitetura do Sistema

```
  ┌────────────────────────────────────────────────────────────────────────┐
  │                           FONTES DE ENTRADA                            │
  │   • Dongle USB ISDB-T (UHF 14–69)   • Stream IP (UDP/SRT)   • Arquivo  │
  └───────────────────────────────────┬────────────────────────────────────┘
                                      │
                     ┌────────────────┴────────────────┐
                     ▼                                 ▼
          ┌──────────────────────┐          ┌──────────────────────┐
          │  Analisador Interno  │          │        FFmpeg        │
          │  Node.js TS Core     │          │ (Hardware / CPU)     │
          │ • ETR 290 (P1,P2,P3) │          │ • Captura JPEG       │
          │ • CRC32 Real         │          │   (1s a 10s ajustável│
          │ • Loudness (-24 LUFS)│          └──────────┬───────────┘
          │ • Closed Caption     │                     │
          │ • EPG (EIT) & SDT    │                     │
          └──────────┬───────────┘                     │
                     │                                 │
                     └────────────────┬────────────────┘
                                      │
                                      ▼
                       ┌─────────────────────────────┐
                       │       Backend Node.js       │
                       │     (Express + WebSocket)   │
                       └──────┬───────────────┬──────┘
                              │               │
            ┌─────────────────┴────┐     ┌────┴──────────────────────────┐
            ▼                      ▼     ▼                               ▼
  ┌──────────────────┐  ┌──────────────────┐  ┌───────────────────────────────┐
  │  /api/metrics    │  │     /metrics     │  │     Dashboard Web em          │
  │     (JSON)       │  │   (Prometheus)   │  │    Tempo Real (HTML/CSS/JS)   │
  │ • Grafana Inf.   │  │ • Prometheus     │  │ • Linha do Tempo EPG (EIT)    │
  │ • Integrações    │  │ • Grafana Server │  │ • Video Frame & Loudness      │
  └──────────────────┘  └──────────────────┘  │ • Alarmes ETR 290 & Tabelas   │
                                              └───────────────────────────────┘
```

---

## 📦 Instalação e Pré-requisitos

### 1. No Linux (Ubuntu / Debian / Raspberry Pi)

```bash
# 1. Atualize os pacotes do sistema
sudo apt update

# 2. Instale o FFmpeg e ferramentas de DVB
sudo apt install -y ffmpeg dvb-tools dtv-scan-tables

# 3. Garanta permissão de acesso ao sintonizador USB para o seu usuário
sudo usermod -aG video $USER
```

### 2. No Windows

1. **FFmpeg**: Baixe em [https://ffmpeg.org/download.html](https://ffmpeg.org/download.html) e adicione ao `PATH` do sistema.
2. **Node.js**: Versão 18 ou superior.

---

## 🚀 Como Executar

```bash
# 1. Acesse o diretório do projeto
cd tsanalyzer

# 2. Instale as dependências
npm install

# 3. Inicie o servidor
npm start
```

Abra o navegador no endereço: **`http://localhost:3000`**

---

## ⚙️ Modos de Operação

### Modo 1: Sintonizador USB UHF (ISDB-T / SBTVD)
1. Conecte o dongle USB (ex: MyGica, Geniatech, PixelView).
2. Selecione o **Canal Físico UHF** desejado (canais 14 ao 69).
3. O campo **Adapter DVB** deve permanecer `0` (padrão para 1 dongle conectado).
4. Clique em **▶ Sintonizar Canal**.
5. O sistema salvará automaticamente a sintonia para que ao recarregar (<kbd>F5</kbd>) o canal permaneça ativo.

### Modo 2: Streaming IP (UDP Multicast / SRT / RIST)
1. Selecione a aba **🌐 Rede IP**.
2. Digite a URL do stream (ex: `udp://@239.0.0.1:1234` ou `srt://192.168.1.100:9000`).
3. Clique em **▶ Conectar Stream**.

### Modo 3: Upload e Análise de Arquivos `.ts`
1. Selecione a aba **📤 Upload de Arquivo**.
2. Arraste ou selecione um arquivo `.ts` de até 500 MB.
3. O analisador processará o fluxo e exibirá o relatório completo.

---

## 📈 Integração com Grafana

### Opção A: Via Prometheus (`/metrics`)
Adicione o endpoint do TS Analyzer no seu arquivo `prometheus.yml`:

```yaml
scrape_configs:
  - job_name: 'ts_analyzer'
    scrape_interval: 2s
    static_configs:
      - targets: ['localhost:3000']
```

### Opção B: Via Grafana Infinity Plugin (`/api/metrics/json`)
1. No Grafana, adicione uma fonte de dados **Infinity**.
2. Aponte para a URL: `http://localhost:3000/api/metrics/json`.
3. Selecione os campos desejados (ex: `loudness.integratedLufs`, `ts.totalBitrateKbps`, `rf.snrDb`).
4. Para escolher quais dados trafegar na rede, clique no botão **`⚙️ Configurar API JSON`** no cabeçalho do painel web.

---

## 🛡️ Licença e Padrões
- **Padrões Suportados**: ABNT NBR 15601 a 15610 (SBTVD), ITU-R BS.1770, ETR 101 290, ISO/IEC 13818-1 (MPEG-2 TS).
