# HE26 Export — Sistema de Exportação e Análise

Sistema de exportação incremental de sessões HRV do Supabase para disco local,
com geração de relatórios por participante e do estudo completo.

## Pré-requisitos

```bash
pip install -r requirements.txt
# config/secrets.yaml com supabase.service_key preenchido
```

## Comandos

```bash
# Exportar só as sessões novas (incremental — corre diariamente)
python scripts/daily_export.py

# Reexportar tudo do zero
python scripts/daily_export.py --force

# Exportar + gerar relatórios HTML
python scripts/daily_export.py --reports

# Só gerar relatórios (sem exportar dados)
python scripts/daily_export.py --reports-only

# Pasta de destino diferente
python scripts/daily_export.py --export-dir /caminho/para/pasta
# ou via variável de ambiente:
HE26_EXPORT_DIR=/caminho/para/pasta python scripts/daily_export.py
```

## Estrutura de saída

```
HE26_export/
├── _export_log.json            ← registo de sessões já exportadas
├── _relatorio_geral.html       ← relatório global (gerado com --reports)
│
└── HM01/
    ├── _relatorio.html         ← relatório do participante
    ├── _sessoes.csv            ← tabela de todas as sessões
    │
    └── 2026-06-19/
        ├── rest_5min_manha/    ← rest_5min antes das 12:00
        │   ├── ecg_raw.csv         (seq, voltage_uv, timestamp_ms)
        │   ├── rr_intervals.csv    (seq, rr_ms, timestamp_ms)
        │   └── metrics.json        (métricas HRV + metadados)
        ├── rest_5min_tarde/    ← rest_5min às 12:00 ou depois
        └── livre_1h/           ← session_type = free
```

## Segurança dos dados

- **Nunca apaga nada do Supabase** — só lê e exporta.
- Escrita atómica: ficheiros escritos em `.tmp` e renomeados atomicamente.
- Se uma sessão já foi exportada, é saltada (a não ser com `--force`).
- Erros numa sessão são registados no log e o script continua para a próxima.

## _export_log.json

Registo incremental de sessões exportadas:
```json
{
  "sessions": {
    "<session_id>": {
      "exported_at": "2026-06-19T10:00:00",
      "folder": "HM01/2026-06-19/rest_5min_manha",
      "status": "ok"
    }
  }
}
```

## Sincronização com Google Drive

Aponta a app Google Drive Desktop para a pasta `HE26_export/`
e ela sincroniza automaticamente cada vez que o script exporta dados novos.

## Módulos utilizados

| Ficheiro | Papel |
|---|---|
| `src/supabase_loader.py` | Leitura do Supabase (reutilizado, + `get_rr_raw`, `get_ecg_raw`) |
| `src/hrv_metrics.py` | Cálculo de RMSSD, lnRMSSD, SDNN, pNN50 (sem alterações) |
| `src/export_engine.py` | Estrutura de pastas, escrita atómica, log incremental |
| `src/report_engine.py` | Relatórios HTML com gráficos matplotlib embutidos |
| `scripts/daily_export.py` | Ponto de entrada CLI |
