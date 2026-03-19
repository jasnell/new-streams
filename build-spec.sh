#!/bin/bash
set -e
mkdir -p out
curl -L --retry 3 --fail \
  https://www.w3.org/publications/spec-generator/ \
  --output out/index.html \
  -F type=bikeshed-spec \
  -F die-on=fatal \
  -F file=@"index.bs"
echo "Built out/index.html"
