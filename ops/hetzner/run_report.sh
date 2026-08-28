#!/bin/bash
set -a
. /opt/ronor/.report_env
set +a
exec /usr/bin/python3 /opt/ronor/ronor_report.py "$1"
