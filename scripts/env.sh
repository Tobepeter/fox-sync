#!/usr/bin/env bash
# 照 okx-test：明文 .env 不提交，sops + age 加密成 secrets/env.sops.yaml 入库
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/.env"
SECRET_FILE="$ROOT/secrets/env.sops.yaml"
SECRET_PROJECT_PATH="secrets/env.sops.yaml"
SOPS_CONFIG="$ROOT/.sops.yaml"

command -v sops >/dev/null 2>&1 || { echo "sops is required" >&2; exit 1; }

case "${1:-}" in
  seal)
    [[ -f "$ENV_FILE" ]] || { echo ".env does not exist" >&2; exit 1; }
    mkdir -p "$(dirname "$SECRET_FILE")"
    tmp="$SECRET_FILE.tmp.$$"
    sops --config "$SOPS_CONFIG" --encrypt --input-type dotenv --output-type yaml \
      --filename-override "$SECRET_PROJECT_PATH" "$ENV_FILE" > "$tmp"
    mv "$tmp" "$SECRET_FILE"
    echo "sealed $SECRET_PROJECT_PATH"
    ;;
  open)
    [[ -f "$SECRET_FILE" ]] || { echo "$SECRET_PROJECT_PATH does not exist" >&2; exit 1; }
    tmp="$ENV_FILE.tmp.$$"
    (umask 077; sops --config "$SOPS_CONFIG" --decrypt --input-type yaml --output-type dotenv "$SECRET_FILE" > "$tmp")
    mv "$tmp" "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    echo "opened .env"
    ;;
  check)
    [[ -f "$SECRET_FILE" ]] || { echo "$SECRET_PROJECT_PATH does not exist" >&2; exit 1; }
    sops --config "$SOPS_CONFIG" --decrypt --input-type yaml --output-type dotenv "$SECRET_FILE" >/dev/null
    echo "checked $SECRET_PROJECT_PATH"
    ;;
  *)
    echo "Usage: scripts/env.sh <open|seal|check>" >&2
    exit 1
    ;;
esac
