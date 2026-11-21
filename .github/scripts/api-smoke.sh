#!/usr/bin/env bash
# End-to-end API check against a running backend on a migrated database:
# upload a public GAEB file, build a draft, price a line, analyse it and export it.
# Usage: .github/scripts/api-smoke.sh [base-url]   (default http://localhost:8080)
set -euo pipefail

base=${1:-http://localhost:8080}
file=test-data/dbinfrago/spgk/SPGK.X83
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
json() { python3 -c "import json,sys; d=json.load(sys.stdin); print(eval(sys.argv[1], {}, {'d': d}))" "$1"; }
get() { curl -fsS "$base$1"; }
post() { curl -fsS -X POST -H 'Content-Type: application/json' --data "$2" "$base$1"; }

for _ in $(seq 1 30); do
    curl -fsS "$base/healthz" >/dev/null 2>&1 && break
    sleep 1
done
[ "$(get /healthz | json 'd["status"]')" = ok ] || fail "backend is not healthy"

project=$(post /api/mvp/project '{"name": "CI smoke"}' | json 'd["id"]')
echo "project $project"

upload=$(curl -fsS -X POST -H 'Content-Type: application/octet-stream' --data-binary "@$file" \
    "$base/api/mvp/upload?project=$project&filename=$(basename "$file")")
document=$(echo "$upload" | json 'd["document_id"]')
status=$(echo "$upload" | json 'd["status"]')
echo "upload $document ($status)"
[ "$status" = parsed ] || fail "upload status $status: $upload"

bom=$(post /api/mvp/draft "{\"document_id\": \"$document\"}" | json 'd["bom_version_id"]')
get "/api/mvp/bom?id=$bom" >"$work/bom.json"
lines=$(json 'len(d["lines"])' <"$work/bom.json")
echo "draft $bom with $lines lines"
[ "$lines" -gt 0 ] || fail "draft has no lines"

revision=$(json 'd["version"]["edit_revision"]' <"$work/bom.json")
line=$(json 'd["lines"][0]["id"]' <"$work/bom.json")
saved=$(post /api/mvp/save "{\"id\": \"$bom\", \"revision\": $revision, \"lines\": [{\"id\": \"$line\", \"draft_unit_price\": \"12.34\"}]}")
[ "$(echo "$saved" | json 'd["version"]["edit_revision"]')" -gt "$revision" ] || fail "save did not bump the revision"
conflict=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' \
    --data "{\"id\": \"$bom\", \"revision\": $revision, \"lines\": [{\"id\": \"$line\", \"draft_unit_price\": \"1\"}]}" \
    "$base/api/mvp/save")
[ "$conflict" = 409 ] || fail "stale save returned $conflict, expected 409"
echo "save ok, stale save rejected"

[ "$(get /api/mvp/rules | json 'len(d["rules"]) > 0')" = True ] || fail "no analysis rules"
analysis=$(post /api/mvp/analyze "{\"id\": \"$bom\", \"layers\": [1, 2]}")
run=$(echo "$analysis" | json 'd["run"]["id"]')
findings=$(echo "$analysis" | json 'len(d["findings"])')
echo "analysis $run with $findings findings"
if [ "$findings" -gt 0 ]; then
    key=$(echo "$analysis" | json 'd["findings"][0]["id"]')
    decided=$(post /api/mvp/finding "{\"run_id\": \"$run\", \"finding_key\": \"$key\", \"status\": \"accepted\"}")
    [ "$(echo "$decided" | json 'd["status"]')" = accepted ] || fail "finding decision: $decided"
fi
[ "$(get "/api/mvp/analysis?id=$bom" | json 'd["outdated"]')" = False ] || fail "fresh analysis reported outdated"

for format in pdf docx x83 x83-31 x82 d83 d84 d86 zip; do
    curl -fsS -o "$work/export.$format" "$base/api/mvp/export?id=$bom&format=$format"
    [ -s "$work/export.$format" ] || fail "empty $format export"
done
head -c 4 "$work/export.pdf" | grep -q '%PDF' || fail "pdf export is not a PDF"
echo "exports ok"

curl -fsS -o "$work/original" "$base/api/mvp/original?id=$document"
cmp -s "$work/original" "$file" || fail "original download differs from the upload"

# BillBuild starts assessment when an imported list reaches the shared workspace.
list_id="smoke-$(python3 -c 'from uuid import uuid4; print(uuid4())')"
file_id="d-$list_id"
upload_change=$(cat <<EOF
{"changes":{"userLists":{"set":{"$list_id":{
  "id":"$list_id","title":"Upload assessment smoke","fileName":"example.csv","currency":"EUR",
  "source":{"kind":"csv"},
  "positions":[
    {"id":"missing-unit","oz":"01.01","short":"Kabelrinne montieren","qty":8,"unit":"","up":22},
    {"id":"concrete","oz":"01.02","short":"Stahlbetonwand C30/37","qty":12,"unit":"m³","up":360}
  ]
}}}}}
EOF
)
post /api/workspace/state "$upload_change" >/dev/null
before_upload=$(curl -sS -o /dev/null -w '%{http_code}' "$base/api/workspace/analysis?id=$list_id")
[ "$before_upload" = 404 ] || fail "a list with no upload started an assessment"
post /api/workspace/state "{\"changes\":{\"userDocuments\":{\"set\":{\"$file_id\":{
    \"name\":\"example.csv\",\"listId\":\"$list_id\",\"original\":true
}}}}}" >/dev/null
for _ in $(seq 1 15); do
    get "/api/workspace/analysis?id=$list_id" >"$work/workspace-assessment.json"
    [ "$(json 'd["state"]' <"$work/workspace-assessment.json")" = queued ] || break
    sleep 1
done
[ "$(json 'd["state"]' <"$work/workspace-assessment.json")" = ready ] || fail "upload did not produce a risk assessment"
[ "$(json 'any(f["rule_id"] == "L2.CONCRETE.STRUCTURE_NEEDS_FORMWORK" for f in d["report"]["findings"])' <"$work/workspace-assessment.json")" = True ] || fail "missing construction warning"
key=$(json 'next(f["id"] for f in d["report"]["findings"] if f["rule_id"] == "L1.UNIT.MISSING")' <"$work/workspace-assessment.json")
post /api/workspace/state "{\"changes\":{
    \"edits\":{\"set\":{\"$list_id\":{\"patch\":{\"missing-unit\":{\"unit\":\"m\"}}}}},
    \"listPatch\":{\"set\":{\"$list_id\":{\"reviewedFindings\":[\"$key\"]}}}
}}" >/dev/null
get "/api/workspace/analysis?id=$list_id" >"$work/workspace-after-edit.json"
cmp -s "$work/workspace-assessment.json" "$work/workspace-after-edit.json" || fail "editing replaced the upload assessment"
post /api/workspace/state "{\"changes\":{
    \"userLists\":{\"delete\":[\"$list_id\"]},\"userDocuments\":{\"delete\":[\"$file_id\"]},
    \"edits\":{\"delete\":[\"$list_id\"]},\"listPatch\":{\"delete\":[\"$list_id\"]}
}}" >/dev/null

echo "API smoke test passed"
