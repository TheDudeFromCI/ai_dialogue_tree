#!/bin/bash

source .venv/bin/activate

if [ -f ".env" ]; then
  echo "Loading environment variables from .env file"
  set -a
  source .env
  set +a
fi

flask run -p "${PORT:-8126}"
