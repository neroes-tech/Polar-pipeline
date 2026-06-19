# Neroes — HE26 Polar H10 Pipeline

Sistema de recolha e análise de HRV para o estudo HE26. Cobre o ciclo completo: app Android/PWA com Bluetooth LE → armazenamento em Supabase → exportação incremental diária → análise com Python/Jupyter.

**Versão app:** 1.4.0 (versionCode 5) · **Stack:** React 18 + Capacitor 7 + Supabase + Python 3

---

## Visão geral

```
Polar H10 ──BLE──► App Android/PWA ──HTTPS──► Supabase
                   (RR + ECG 130 Hz)           (PostgreSQL + Auth)
                                                    │
                                         daily_export.py (cron / manual)
                                                    │
                                         HE26_export/<CÓDIGO>/<DATA>/<TIPO>/
                                           ├── rr_intervals.csv
                                           ├── metrics.json
                                           ├── ecg_samples.parquet
                                           └── relatório_participante.html
                                                    │
                                         notebooks/ (limpeza → EDA → análise)
```

**Participantes:** HM01–HM29 (29 participantes, códigos anonimizados)  
**Bandas:** Polar H10 (RR intervals via HRM + ECG bruto 130 Hz via PMD)  
**Sessões:** repouso 5 min (manhã / tarde) e livre 1 h

---

## Estrutura do projeto

```
neroes_polar_pipeline/
│
├── app/                          # React + Vite + Capacitor (Android / PWA)
│   ├── src/
│   │   ├── screens/              # Login, ParticipantSelect, Record
│   │   ├── components/           # BigButton, EcgCanvas, HrChart, Footer, LanguageToggle
│   │   ├── lib/                  # BLE, HRV, sessão, offline, foreground service
│   │   ├── i18n/                 # pt.json + en.json
│   │   └── styles/
│   ├── public/                   # manifest.json, ícones PWA
│   ├── .env.example              # VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY
│   ├── capacitor.config.json     # appId: com.neroes.hrv
│   ├── vite.config.js
│   └── sync_to_windows.sh        # build + cap sync + cópia para Windows
│
├── scripts/
│   ├── daily_export.py           # Exportação incremental Supabase → HE26_export/
│   ├── run_daily_export.sh       # Wrapper com resolução de Python (cron / Task Scheduler)
│   ├── create_auth_users.py      # Cria utilizadores em Supabase Auth
│   ├── seed_participants.py      # Popula tabela participants
│   ├── export_to_parquet.py      # Converte HE26_export → parquet adicional
│   └── setup_supabase_schema.sql # DDL inicial (sessions, participants, ecg_samples)
│
├── src/                          # Módulos Python reutilizáveis
│   ├── hrv_metrics.py            # Filtragem de artefactos + compute_hrv()
│   ├── supabase_loader.py        # Query sessions + participants do Supabase
│   ├── export_engine.py          # Exportação atómica com log incremental
│   ├── report_engine.py          # Relatórios HTML com gráficos matplotlib
│   ├── feature_engineering.py    # Limpeza, gaps, anomalias (z-score + IQR)
│   ├── polar_parser.py           # Parse de CSVs exportados do Polar Flow
│   ├── polar_accesslink.py       # Cliente Polar AccessLink API (OAuth2)
│   └── eda_utils.py              # Helpers EDA
│
├── notebooks/
│   ├── 00_polar_accesslink_setup.ipynb
│   ├── 01_data_ingestion.ipynb
│   ├── 02_cleaning_and_engineering.ipynb
│   └── 03_eda_and_analysis.ipynb
│
├── config/
│   ├── secrets.yaml.example      # Template — copiar para secrets.yaml
│   └── participants.yaml.example # Template — copiar para participants.yaml
│
├── data/                         # (git-ignored) raw/, processed/, reports/
├── HE26_export/                  # (git-ignored) saída clínica estruturada
└── requirements.txt
```

---

## Configuração inicial

### 1. Credenciais Supabase

```bash
cp config/secrets.yaml.example config/secrets.yaml
```

Preencher `config/secrets.yaml`:
```yaml
supabase:
  url: "https://SEU_PROJECT_ID.supabase.co"
  anon_key: "eyJ..."        # chave anon (app)
  service_key: "eyJ..."     # chave service_role (scripts Python)
```

### 2. App — variáveis de ambiente

```bash
cd app
cp .env.example .env
```

Preencher `app/.env`:
```
VITE_SUPABASE_URL=https://SEU_PROJECT_ID.supabase.co
VITE_SUPABASE_ANON_KEY=eyJ...
```

### 3. Schema Supabase

Correr uma vez no SQL Editor do Supabase:
```bash
# copiar e executar o conteúdo de:
scripts/setup_supabase_schema.sql
```

Tabelas criadas: `participants`, `sessions` (RR intervals + métricas JSON), `ecg_samples` (ECG 130 Hz opcional).

### 4. Participantes

```bash
cp config/participants.yaml.example config/participants.yaml
# editar: adicionar device_id de cada banda Polar H10
python scripts/seed_participants.py   # INSERT na tabela participants
python scripts/create_auth_users.py   # criar utilizadores Supabase Auth
```

### 5. Pipeline Python

```bash
python -m venv .venv
source .venv/bin/activate          # Windows WSL: source .venv/bin/activate
pip install -r requirements.txt
jupyter lab
```

---

## App Android / PWA

### Desenvolvimento no browser

```bash
cd app
npm install
npm run dev                        # http://localhost:5173
```

Web Bluetooth funciona no Chrome/Edge com dispositivo BLE em alcance.

### Build Android (WSL + Windows)

O Android Studio não compila a partir de caminhos `\\wsl$\...`. O script trata de tudo:

```bash
cd app
./sync_to_windows.sh
```

O que o script faz:
1. `npm run build` → compila web para `dist/`
2. `npx cap sync android` → sincroniza assets e plugins Capacitor
3. Copia `android/` para `C:\Users\bruno\neroes_app_android\` via rsync

Depois, no **Android Studio (Windows)**:
- **File → Open** → `C:\Users\bruno\neroes_app_android`
- Aguardar Gradle sync (primeira vez: 2–5 min)
- Ligar telemóvel USB com Depuração USB ativa
- Clicar **▶ Run**

### Gerar APK de distribuição

**Build → Build Bundle(s) / APK(s) → Build APK(s)**

Saída: `app\build\outputs\apk\debug\app-debug.apk`

### Requisitos Android

| Item | Valor |
|---|---|
| `applicationId` | `com.neroes.hrv` |
| `minSdkVersion` | 24 (Android 7.0) |
| `compileSdkVersion` | 35 |
| `versionName` | 1.4.0 |
| Bluetooth | BLUETOOTH_SCAN, BLUETOOTH_CONNECT (API 31+) + legacy (API ≤ 30) |
| Foreground service | FOREGROUND_SERVICE_CONNECTED_DEVICE (Android 14+) |
| Notificações | POST_NOTIFICATIONS (runtime, Android 13+) |

---

## Fluxo de recolha de dados

1. Investigador abre a app → seleciona participante
2. App liga via BLE ao Polar H10 do participante (device_id em `participants.yaml`)
3. Sessão inicia: app recolhe RR intervals (HRM) + ECG bruto 130 Hz (PMD, se ativo)
4. Métricas HRV calculadas ao vivo (RMSSD, lnRMSSD, SDNN, pNN50)
5. Ecrã mantém-se ligado (Screen Wake Lock / `@capacitor-community/keep-awake`)
6. Android: foreground service garante continuidade em background
7. No fim: dados enviados para Supabase; se sem internet → fila offline (Capacitor Preferences) com sync automático quando a ligação regressar

---

## Exportação diária

### Execução manual

```bash
# Exportar sessões novas (incremental)
python scripts/daily_export.py

# Com relatórios HTML por participante
python scripts/daily_export.py --reports

# Reexportar tudo (ignora log)
python scripts/daily_export.py --force --reports

# Só regenerar relatórios (sem exportar sessões)
python scripts/daily_export.py --reports-only

# Sem cópia para Google Drive
python scripts/daily_export.py --no-drive

# Destino personalizado
python scripts/daily_export.py --export-dir /caminho/destino
```

### Agendamento automático (Windows Task Scheduler)

```
Programa: wsl
Argumentos: bash /home/bruno1008/Neroes/neroes_polar_pipeline/scripts/run_daily_export.sh
Trigger: diário às 07:00
```

O `run_daily_export.sh` resolve automaticamente o Python correto (`.venv` → pyenv 3.11.6 → sistema) e corre `--reports` por defeito.

### Estrutura de saída

```
HE26_export/
├── _export_log.json              # registo incremental de sessões exportadas
├── _run_log.txt                  # timestamp de cada execução
├── _relatorio_geral.html         # relatório consolidado de todos os participantes
│
└── HM01/
    └── 2026-06-19/
        ├── rest_5min_manha/      # session_type="rest_5min", hora < 12h
        │   ├── rr_intervals.csv
        │   ├── metrics.json
        │   ├── ecg_samples.parquet   (se ECG ativo)
        │   └── relatório_participante.html
        └── rest_5min_tarde/      # session_type="rest_5min", hora ≥ 12h
            └── ...
```

**Tipos de pasta:** `rest_5min_manha`, `rest_5min_tarde`, `livre_1h`

---

## Métricas HRV

Calculadas em `src/hrv_metrics.py` e ao vivo em `app/src/lib/hrvCalc.js`.

### Filtragem de artefactos (2 passes)

1. **Range:** remove RR fora de [300, 1500] ms
2. **Ectopic:** remove RR com variação > 20% face ao anterior

### Métricas calculadas (`compute_hrv`)

| Métrica | Descrição |
|---|---|
| `n_rr` | Número de intervalos RR válidos |
| `mean_rr` | RR médio (ms) |
| `hr_resting_mean` | FC média (bpm) = 60 000 / mean_rr |
| `hr_min` / `hr_max` | FC mínima / máxima (bpm) |
| `sdnn` | Desvio padrão de todos os NN intervals (variabilidade total) |
| `rmssd` | Raiz quadrada das diferenças sucessivas ao quadrado (atividade parassimpática) |
| `lnrmssd` | Logaritmo natural do RMSSD (comparação entre sujeitos) |
| `pnn50` | % de diferenças sucessivas > 50 ms |
| `data_quality_pct` | % de RR mantidos após filtragem |
| `quality_flag` | `good` (≥ 80%), `fair` (70–80%), `poor` (< 70%), `insufficient_data` |

---

## Notebooks de análise

| Ordem | Notebook | Entrada | Saída |
|---|---|---|---|
| 0 | `00_polar_accesslink_setup.ipynb` | OAuth2 Polar API | `config/tokens.yaml` |
| 1 | `01_data_ingestion.ipynb` | Supabase / CSVs Polar Flow | `master_long.parquet` |
| 2 | `02_cleaning_and_engineering.ipynb` | `master_long.parquet` | `master_long_clean.parquet`, `master_short.parquet` |
| 3 | `03_eda_and_analysis.ipynb` | ambos os parquets | `data/reports/eda_report.html` |

---

## Adicionar um novo participante

1. Editar `config/participants.yaml` (adicionar código + device_id da banda H10):
   ```yaml
   - code: "HM30"
     device_id: "XXXXXXXX"   # MAC hex sem separadores (ver etiqueta da banda)
     name: null
     birthdate: null
     gender: null
     height_cm: null
     weight_kg: null
   ```
2. Sincronizar com Supabase:
   ```bash
   python scripts/seed_participants.py
   python scripts/create_auth_users.py   # se precisar de login novo
   ```
3. O participante aparece imediatamente no selector da app.

---

## Data de corte: teste vs. estudo real

O estudo HE26 começou em **2026-06-20**. Sessões com `session_date` anterior a essa data foram recolhidas durante o setup e são consideradas dados de teste.

A data de corte está em `config/study.yaml`:
```yaml
study:
  start_date: "2026-06-20"
```

**Comportamento por defeito:**
- `get_sessions()` e `build_master_dataframe()` (análise nos notebooks) filtram automaticamente para `session_date >= 2026-06-20`.
- A exportação diária (`daily_export.py` / `ExportEngine`) **exporta sempre tudo**, incluindo sessões de teste — para não perder dados.

**Override para ver dados de teste:**
```python
# Incluir todas as sessões (teste + estudo)
df = get_sessions(start_date=None)
df = build_master_dataframe(start_date=None)

# Ou passar uma data antes do setup:
df = get_sessions(start_date="2020-01-01")
```

Os dados de teste não são apagados — ficam na base de dados e em `HE26_export/` para referência.

---

## Segurança e RGPD

O repositório não contém dados clínicos nem credenciais. O `.gitignore` exclui:

- `config/secrets.yaml` — chaves Supabase
- `config/participants.yaml` — device IDs e dados demográficos
- `HE26_export/` — dados clínicos exportados
- `data/raw/`, `data/processed/`, `data/reports/` — dados de análise
- `app/.env` — chaves da app
- `app/android/` — projeto nativo (gerado por `sync_to_windows.sh`)
- `app/android/keystore.properties`, `neroes-release-keys/` — chaves de assinatura APK

Os ficheiros `*.example` em `config/` mostram a estrutura sem valores reais.
