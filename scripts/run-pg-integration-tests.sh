#!/bin/bash
# P0.3 PostgreSQL integration test runner.
#
# Runs all four PG suites independently, each against its own isolated _test
# database. Reports PASS/FAIL per suite. Cleans up on success and failure.
#
# Usage:
#   PG_PASSWORD=<password> bash scripts/run-pg-integration-tests.sh
#
# Environment:
#   PG_CONTAINER  - Docker container name (default: restaurant-postgres)
#   PG_USER       - PostgreSQL superuser (default: lwc)
#   PG_PASSWORD   - PostgreSQL password (required, no default)
#   REPO          - Repository root (auto-detected from script location)
#   KEEP_TEST_DB  - If set to 1, do not drop test databases after run
#   EXPECTED_COMMIT - Required source commit SHA (fail if mismatch)

set -uo pipefail

PG_CONTAINER="${PG_CONTAINER:-restaurant-postgres}"
PG_USER="${PG_USER:-lwc}"
PG_PASSWORD="${PG_PASSWORD:-}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KEEP_TEST_DB="${KEEP_TEST_DB:-0}"
EXPECTED_COMMIT="${EXPECTED_COMMIT:-e93550c3d28f1024f3e38a90730c03f8c30d203f}"

# Track databases this run created (for safe cleanup)
declare -a CREATED_DBS=()
CLEANUP_ERRORS=()
RESULTS=()

# Never print passwords or connection strings
if [[ -n "$PG_PASSWORD" ]]; then
  export PGPASSWORD="$PG_PASSWORD"
fi

cleanup() {
  local exit_code=$?
  echo ""
  echo "=== Cleanup (exit code: $exit_code) ==="

  for db_name in "${CREATED_DBS[@]}"; do
    if docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d postgres -c "DROP DATABASE IF EXISTS \"$db_name\"" >/dev/null 2>&1; then
      echo "  [cleanup] Dropped $db_name"
    else
      echo "  [cleanup] FAILED to drop $db_name" >&2
      CLEANUP_ERRORS+=("$db_name")
    fi
  done

  if [[ ${#CLEANUP_ERRORS[@]} -gt 0 ]]; then
    echo "  [cleanup] WARNING: ${#CLEANUP_ERRORS[@]} database(s) could not be dropped" >&2
  fi

  exit $exit_code
}

trap cleanup EXIT INT TERM

# === SAFETY CHECK 1: Verify source commit ===
echo "=== PostgreSQL Integration Test Runner ==="
COMMIT=$(git -C "$REPO" rev-parse HEAD 2>/dev/null || echo "unknown")
echo "Commit: $COMMIT"
echo "Container: $PG_CONTAINER"
echo "User: $PG_USER"
echo ""

if [[ "$COMMIT" != "$EXPECTED_COMMIT" ]]; then
  echo "ERROR: Source commit $COMMIT does not match expected $EXPECTED_COMMIT" >&2
  echo "Tests will NOT run. Aborting." >&2
  exit 1
fi

# === SAFETY CHECK 2: Verify working tree is clean ===
if [[ -n $(git -C "$REPO" status --porcelain 2>/dev/null) ]]; then
  echo "ERROR: Working tree has uncommitted changes. Aborting." >&2
  git -C "$REPO" status --porcelain 2>/dev/null | head -5 >&2
  exit 1
fi

# === SAFETY CHECK 3: Verify password is set ===
if [[ -z "$PG_PASSWORD" ]]; then
  echo "ERROR: PG_PASSWORD environment variable is required" >&2
  exit 1
fi

# === SAFETY CHECK 4: Verify container is running ===
if ! docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d postgres -tAc "SELECT 1" >/dev/null 2>&1; then
  echo "ERROR: Cannot connect to PostgreSQL container $PG_CONTAINER" >&2
  exit 1
fi

# === SAFETY CHECK 5: Verify Node.js connectivity to PostgreSQL ===
echo "=== Verifying Node.js PostgreSQL connectivity ==="
if ! node -e "
const pg = require('pg');
const client = new pg.Client({ connectionString: 'postgresql://${PG_USER}:${PG_PASSWORD}@localhost:5432/postgres' });
client.connect()
  .then(() => client.query('SELECT 1'))
  .then(() => { console.log('  [PASS] Node.js can connect to PostgreSQL'); client.end(); })
  .catch((e) => { console.error('  [FAIL] Node.js cannot connect:', e.message); process.exit(1); });
" 2>&1; then
  echo "ERROR: Node.js PostgreSQL connectivity check failed" >&2
  exit 1
fi
echo ""

# === SAFETY CHECK 6: Validate database names ===
validate_db_name() {
  local name="$1"
  # Must end in _test
  if [[ ! "$name" =~ _test$ ]]; then
    echo "  [FAIL] Database name must end in _test: $name" >&2
    return 1
  fi
  # Must not be lwc_saas or any production database
  if [[ "$name" == "lwc_saas" || "$name" == "postgres" || "$name" == "template0" || "$name" == "template1" ]]; then
    echo "  [FAIL] Database name is reserved: $name" >&2
    return 1
  fi
  # Must only contain safe characters
  if [[ ! "$name" =~ ^[a-z_][a-z0-9_]*$ ]]; then
    echo "  [FAIL] Database name contains unsafe characters: $name" >&2
    return 1
  fi
  return 0
}

# Generate unique database name with timestamp
generate_db_name() {
  local prefix="$1"
  local timestamp=$(date +%s)
  echo "${prefix}_${timestamp}_test"
}

# Test suites
SUITES=(
  "test-pg-delivery-integration"
  "test-manual-reply-pg"
  "test-p03-final-pg"
  "test-human-operations-pg"
)

run_suite() {
  local suite_name="$1"
  local db_name="$2"
  local script_path="scripts/${suite_name}.mjs"

  echo "=== Running $suite_name (database: $db_name) ==="

  # Validate database name
  if ! validate_db_name "$db_name"; then
    RESULTS+=("FAIL:$suite_name")
    return 1
  fi

  # Create isolated test database
  if ! docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d postgres -c "CREATE DATABASE \"$db_name\"" >/dev/null 2>&1; then
    echo "  [FAIL] Could not create database $db_name" >&2
    RESULTS+=("FAIL:$suite_name")
    return 1
  fi
  CREATED_DBS+=("$db_name")
  echo "  [setup] Created $db_name"

  # Install pgvector if available
  docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$db_name" -c "CREATE EXTENSION IF NOT EXISTS vector" >/dev/null 2>&1 || true

  # Run the test suite (password passed via PGPASSWORD env var, not in URL)
  local output
  output=$(cd "$REPO" && PGPASSWORD="$PG_PASSWORD" TEST_DATABASE_URL="postgresql://${PG_USER}@localhost:5432/${db_name}" ENCRYPTION_KEY="0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" node "$script_path" 2>&1)
  local exit_code=$?

  echo "$output" | tail -5

  if [[ $exit_code -eq 0 ]]; then
    echo "  [PASS] $suite_name"
    RESULTS+=("PASS:$suite_name")
  else
    echo "  [FAIL] $suite_name (exit code: $exit_code)" >&2
    RESULTS+=("FAIL:$suite_name")
  fi

  # Cleanup (unless KEEP_TEST_DB=1)
  if [[ "$KEEP_TEST_DB" != "1" ]]; then
    if docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d postgres -c "DROP DATABASE IF EXISTS \"$db_name\"" >/dev/null 2>&1; then
      echo "  [cleanup] Dropped $db_name"
      # Remove from created list after successful drop
      CREATED_DBS=("${CREATED_DBS[@]/$db_name}")
    else
      echo "  [cleanup] FAILED to drop $db_name" >&2
      CLEANUP_ERRORS+=("$db_name")
    fi
  else
    echo "  [cleanup] KEEP_TEST_DB=1, keeping $db_name"
  fi

  echo ""
  return $exit_code
}

# Run all suites
for suite_name in "${SUITES[@]}"; do
  db_name=$(generate_db_name "lwc_pg_${suite_name//-/_}")
  run_suite "$suite_name" "$db_name" || true
done

# Summary
echo "=== Summary ==="
PASS_COUNT=0
FAIL_COUNT=0
for result in "${RESULTS[@]}"; do
  if [[ "$result" == PASS:* ]]; then
    PASS_COUNT=$((PASS_COUNT + 1))
    echo "  PASS: ${result#PASS:}"
  else
    FAIL_COUNT=$((FAIL_COUNT + 1))
    echo "  FAIL: ${result#FAIL:}"
  fi
done

echo ""
echo "Total: $((PASS_COUNT + FAIL_COUNT)), Pass: $PASS_COUNT, Fail: $FAIL_COUNT"

if [[ ${#CLEANUP_ERRORS[@]} -gt 0 ]]; then
  echo ""
  echo "WARNING: Failed to cleanup: ${CLEANUP_ERRORS[*]}" >&2
fi

# Exit with failure if any suite failed or cleanup failed
if [[ $FAIL_COUNT -gt 0 || ${#CLEANUP_ERRORS[@]} -gt 0 ]]; then
  exit 1
fi

exit 0
