#!/bin/sh
# Samples CPU and resident memory of a running app's processes once per second and prints a
# summary. Reads only `ps` process statistics; it never touches app data or activity files.
#
#   sh scripts/sample-app-resources.sh "OpenHistory Focus" 120 > focus-resources.csv
#
# Run it once while idle and once during a Focus session to compare. Output is CSV
# (seconds,cpu_percent,rss_megabytes) followed by a "# summary" line on stderr.
set -eu

pattern="${1:-OpenHistory Focus}"
duration="${2:-60}"
case "${duration}" in
  ''|*[!0-9]*) echo "Duration must be a whole number of seconds" >&2; exit 1 ;;
esac

echo "seconds,cpu_percent,rss_megabytes"
elapsed=0
samples=0
cpu_total=0
cpu_max=0
rss_max=0
while [ "${elapsed}" -lt "${duration}" ]; do
  line="$(ps -axo pcpu=,rss=,command= | awk -v pattern="${pattern}" '
    index($0, pattern ".app/Contents/") { cpu += $1; rss += $2 }
    END { printf "%.1f %.1f", cpu, rss / 1024 }')"
  cpu="${line% *}"
  rss="${line#* }"
  echo "${elapsed},${cpu},${rss}"
  samples=$((samples + 1))
  cpu_total="$(awk -v a="${cpu_total}" -v b="${cpu}" 'BEGIN { printf "%.1f", a + b }')"
  cpu_max="$(awk -v a="${cpu_max}" -v b="${cpu}" 'BEGIN { print (b > a ? b : a) }')"
  rss_max="$(awk -v a="${rss_max}" -v b="${rss}" 'BEGIN { print (b > a ? b : a) }')"
  sleep 1
  elapsed=$((elapsed + 1))
done

awk -v total="${cpu_total}" -v samples="${samples}" -v cpu_max="${cpu_max}" -v rss_max="${rss_max}" \
  'BEGIN { printf "# summary: samples=%d avg_cpu=%.2f%% max_cpu=%.1f%% max_rss=%.1fMB\n", samples, (samples ? total / samples : 0), cpu_max, rss_max }' >&2
