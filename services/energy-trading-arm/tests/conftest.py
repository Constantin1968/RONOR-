"""Shared fixtures.

``data/`` is live: the 24/7 ``fetch`` job completes ``prices_*.csv`` from OPCOM/OREE as
the days are published. Tests that describe the *before publication* moment take a
frozen copy instead of the repository folder.
"""

from __future__ import annotations

import csv
import shutil
from pathlib import Path

import pytest


def data_before_opcom(tmp_path: Path, day: str = "2026-09-14") -> Path:
    """Copy of ``data/`` with the RO column of ``prices_<day>.csv`` blanked."""
    data = tmp_path / "data_frozen"
    shutil.copytree(Path("data"), data, dirs_exist_ok=True)
    path = data / f"prices_{day}.csv"
    if path.exists():
        with open(path, newline="") as f:
            reader = csv.DictReader(f)
            rows = list(reader)
            fields = reader.fieldnames or []
        for row in rows:
            row["ro_dam_eur"] = ""
        with open(path, "w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=fields)
            w.writeheader()
            w.writerows(rows)
    (data / "sources").mkdir(exist_ok=True)
    return data


@pytest.fixture
def frozen_data(tmp_path: Path) -> Path:
    return data_before_opcom(tmp_path)
