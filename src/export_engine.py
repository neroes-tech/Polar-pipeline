"""
export_engine.py — Motor de exportação de sessões HE26.

Responsável por:
- Nomear e criar a estrutura de pastas (HE26_export/<CODIGO>/<DATA>/<TIPO>/)
- Escrever ficheiros de forma atómica (escreve .tmp e faz rename)
- Gerir o registo incremental _export_log.json
- Nunca apagar nem modificar dados no Supabase
"""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING

import numpy as np
import pandas as pd

if TYPE_CHECKING:
    pass

REPO_ROOT = Path(__file__).resolve().parent.parent


# ── Utilitários de escrita atómica ────────────────────────────────────────────

def _write_text_atomic(path: Path, content: str) -> None:
    """Escreve conteúdo de texto em .tmp e renomeia — nunca deixa ficheiro a meio."""
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(content, encoding="utf-8")
    os.replace(tmp, path)


def _write_json_atomic(path: Path, obj: object) -> None:
    """Serializa obj para JSON e escreve de forma atómica."""
    _write_text_atomic(path, json.dumps(obj, ensure_ascii=False, indent=2, default=str))


def _write_bytes_atomic(path: Path, data: bytes) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_bytes(data)
    os.replace(tmp, path)


# ── Nomeação de pastas ────────────────────────────────────────────────────────

def session_folder_name(session_type: str | None, session_time: str | None) -> str:
    """
    Converte o tipo de sessão e hora em nome de pasta:
        rest_5min + antes das 12:00 → rest_5min_manha
        rest_5min + 12:00 ou depois → rest_5min_tarde
        free → livre_1h
    """
    if session_type == "free":
        return "livre_1h"

    if session_type == "rest_5min":
        try:
            hora = int(str(session_time or "12:00:00").split(":")[0])
        except (ValueError, IndexError):
            hora = 12
        return "rest_5min_manha" if hora < 12 else "rest_5min_tarde"

    # tipo desconhecido ou None
    tipo = str(session_type or "sessao").replace(" ", "_").lower()
    return f"sessao_{tipo}"


def resolve_unique_folder(parent: Path, base_name: str) -> Path:
    """
    Garante nome único na pasta pai. Se base_name existe, tenta
    base_name_2, base_name_3, … até encontrar um livre.
    """
    candidate = parent / base_name
    if not candidate.exists():
        return candidate
    n = 2
    while True:
        candidate = parent / f"{base_name}_{n}"
        if not candidate.exists():
            return candidate
        n += 1


# ── Log incremental ───────────────────────────────────────────────────────────

class ExportLog:
    """
    Gere o ficheiro _export_log.json na raiz da exportação.

    Estrutura interna:
        {
          "created_at": "...",
          "last_run":   "...",
          "sessions": {
            "<session_id>": {
              "exported_at": "...",
              "folder": "HM01/2026-06-19/rest_5min_manha",
              "status": "ok" | "error",
              "error": "..."  (só quando status=error)
            }
          }
        }
    """

    def __init__(self, log_path: Path) -> None:
        self.path = log_path
        self._data: dict = self._load()

    def _load(self) -> dict:
        if self.path.exists():
            try:
                return json.loads(self.path.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError):
                pass
        return {"created_at": datetime.now().isoformat(), "sessions": {}}

    def save(self) -> None:
        self._data["last_run"] = datetime.now().isoformat()
        _write_json_atomic(self.path, self._data)

    def is_exported(self, session_id: str) -> bool:
        entry = self._data["sessions"].get(str(session_id), {})
        return entry.get("status") == "ok"

    def mark_ok(self, session_id: str, folder: str) -> None:
        self._data["sessions"][str(session_id)] = {
            "exported_at": datetime.now().isoformat(),
            "folder": folder,
            "status": "ok",
        }

    def mark_error(self, session_id: str, error: str) -> None:
        existing = self._data["sessions"].get(str(session_id), {})
        self._data["sessions"][str(session_id)] = {
            **existing,
            "last_error_at": datetime.now().isoformat(),
            "error": error,
            "status": "error",
        }

    def known_ids(self) -> set[str]:
        return set(self._data["sessions"].keys())


# ── Motor principal ───────────────────────────────────────────────────────────

class ExportEngine:
    """
    Exporta sessões HE26 do Supabase para disco.

    Uso:
        engine = ExportEngine(export_dir=Path("HE26_export"))
        n_new, n_skip, errors = engine.run(force=False)
    """

    def __init__(self, export_dir: Path) -> None:
        self.export_dir = export_dir
        self.export_dir.mkdir(parents=True, exist_ok=True)
        self.log = ExportLog(export_dir / "_export_log.json")

    # ── Exportação de uma sessão ──────────────────────────────────────────────

    def export_session(
        self,
        sess: pd.Series,
        rr_df: pd.DataFrame,
        ecg_df: pd.DataFrame,
        metrics: dict,
    ) -> Path:
        """
        Escreve os 3 ficheiros de uma sessão de forma atómica.
        Devolve o Path da pasta criada.
        """
        code         = str(sess.get("participant_code") or "UNKNOWN")
        date_str     = str(sess["session_date"])
        session_time = str(sess.get("session_time") or "00:00:00")
        session_type = sess.get("session_type")

        # Determinar nome da pasta da sessão
        folder_base = session_folder_name(session_type, session_time)
        base_dir    = self.export_dir / code / date_str
        session_dir = resolve_unique_folder(base_dir, folder_base)
        session_dir.mkdir(parents=True, exist_ok=True)

        # 1. rr_intervals.csv
        if not rr_df.empty:
            _write_text_atomic(session_dir / "rr_intervals.csv", rr_df.to_csv(index=False))

        # 2. ecg_raw.csv (só se existir ECG)
        if not ecg_df.empty:
            _write_text_atomic(session_dir / "ecg_raw.csv", ecg_df.to_csv(index=False))

        # 3. metrics.json — métricas HRV + metadados completos
        output = {
            "metadata": {
                "session_id":       str(sess["id"]),
                "participant_code": code,
                "session_date":     date_str,
                "session_time":     session_time,
                "session_type":     session_type,
                "duration_s":       sess.get("duration_s"),
                "has_ecg":          bool(sess.get("has_ecg", False)),
                "ecg_samples":      len(ecg_df),
                "n_rr_raw":         len(rr_df),
                "exported_at":      datetime.now().isoformat(),
            },
            "hrv_metrics": metrics,
        }
        _write_json_atomic(session_dir / "metrics.json", output)

        return session_dir

    # ── Ciclo principal ───────────────────────────────────────────────────────

    def run(self, force: bool = False, verbose: bool = True) -> tuple[int, int, list[str]]:
        """
        Exporta sessões do Supabase para disco.

        Parâmetros
        ----------
        force   : Se True, reexporta mesmo as sessões já no log.
        verbose : Se True, imprime progresso no terminal.

        Devolve
        -------
        (n_new, n_skip, errors)
            n_new  : sessões exportadas nesta execução
            n_skip : sessões já existentes (ignoradas)
            errors : lista de strings descrevendo erros
        """
        # Importações tardias para não criar dependência circular
        sys.path.insert(0, str(REPO_ROOT))
        from src.supabase_loader import get_sessions, get_rr_raw, get_ecg_raw
        from src.hrv_metrics     import compute_hrv

        if verbose:
            print("\n══════════════════════════════════════════")
            print("  HE26 Export — início")
            print(f"  Destino: {self.export_dir}")
            if force:
                print("  Modo: --force (reexporta tudo)")
            print("══════════════════════════════════════════\n")

        sessions = get_sessions(start_date=None)  # export always includes test sessions
        if sessions.empty:
            if verbose:
                print("  Nenhuma sessão encontrada no Supabase.")
            return 0, 0, []

        if verbose:
            print(f"  {len(sessions)} sessões no Supabase\n")

        n_new   = 0
        n_skip  = 0
        errors: list[str] = []

        for _, sess in sessions.iterrows():
            sid  = str(sess["id"])
            code = str(sess.get("participant_code") or "UNKNOWN")
            date = str(sess["session_date"])
            tipo = sess.get("session_type") or "?"

            prefix = f"  [{code}] {date} {tipo}"

            # Verificar se já foi exportada
            if not force and self.log.is_exported(sid):
                if verbose:
                    print(f"{prefix} … já exportada, a saltar")
                n_skip += 1
                continue

            try:
                # Carregar dados do Supabase
                rr_df  = get_rr_raw(sid)
                ecg_df = get_ecg_raw(sid) if sess.get("has_ecg") else pd.DataFrame(
                    columns=["seq", "voltage_uv", "timestamp_ms"]
                )

                if rr_df.empty or len(rr_df) < 2:
                    raise ValueError(f"RR insuficientes ({len(rr_df)} beats)")

                # Calcular métricas HRV
                metrics = compute_hrv(rr_df["rr_ms"].values)

                # Escrever ficheiros
                session_dir = self.export_session(sess, rr_df, ecg_df, metrics)

                # Atualizar log
                rel = str(session_dir.relative_to(self.export_dir))
                self.log.mark_ok(sid, rel)
                n_new += 1

                ecg_info = f" + {len(ecg_df):,} ECG" if not ecg_df.empty else ""
                if verbose:
                    print(
                        f"{prefix} ✓  {len(rr_df)} RR{ecg_info}"
                        f" | lnRMSSD={metrics.get('lnrmssd') or '—'}"
                        f" | qualidade={metrics.get('data_quality_pct') or '—'}%"
                        f"\n          → {rel}"
                    )

            except Exception as exc:
                msg = f"{prefix} ✗  ERRO: {exc}"
                errors.append(msg)
                self.log.mark_error(sid, str(exc))
                if verbose:
                    print(msg)

        self.log.save()

        if verbose:
            print("\n══════════════════════════════════════════")
            print(f"  Novas exportadas : {n_new}")
            print(f"  Já existentes    : {n_skip}")
            print(f"  Erros            : {len(errors)}")
            print("══════════════════════════════════════════\n")

        return n_new, n_skip, errors
