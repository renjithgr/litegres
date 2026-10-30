#!/usr/bin/env bash
# usage: run-suite.sh <template|litegres> <forks>
B=$1; F=$2
./reset.sh
S=$(date +%s)
./gradlew test -Pbackend=$B -Pforks=$F -PprepareWorkaround=false -PlitegresRuntimeDir=/tmp/litegres-spike-rt --console=plain -q > /tmp/suite-$B-f$F.txt 2>&1
echo "$B forks=$F wall=$(( $(date +%s) - S ))s"
