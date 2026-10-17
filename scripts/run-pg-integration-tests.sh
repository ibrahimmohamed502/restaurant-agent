#!/bin/bash
# P0.3 PostgreSQL integration test runner.
#
# Runs all four PG suites independently, each against its own isolated _test
# database. Reports PASS/FAIL per suite. Cleans up on success and failure.
#
# Usage:
#   POSTGRES_PASSWORD=<password> bash scripts/run-pg-integration-tests.sh
#
# Environment:
#   PG_CONTAINER  - Docker container name (default: restaurant-postgres)
#   PG_USER       - PostgreSQL superuser (default: lwc)
#   PG_PASSWORD   - PostgreSQL password (required, no default)
#   REPO          - Repository root (auto-detected from script location)
#   KEEP_TEST_DB  - If set to 1, do not drop test databases after run

set -uo pipefail

PG_CONTAINER="${PG_CONTAINER:-restaurant-postgres}"
PG_USER="${PG_USER:-lwc}"
PG_PASSWORD="${PG_PASSWORD:-}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KEEP_TEST_DB="${KEEP_TEST_DB:-0}"

if [[ -z "$PG_PASSWORD" ]]; then
  echo "ERROR: PG_PASSWORD environment variable is required" >&2
  exit 1
fi

# Verify commit
COMMIT=$(git -C "$REPO" rev-parse HEAD 2>/dev/null || echo "unknown")
echo "=== PostgreSQL Integration Test Runner ==="
echo "Commit: $COMMIT"
echo "Container: $PG_CONTAINER"
echo "User: $PG_USER"
echo ""

# Safety: verify container is running
if ! docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d postgres -tAc "SELECT 1" >/dev/null 2>&1; then
  echo "ERROR: Cannot connect to PostgreSQL container $PG_CONTAINER" >&2
  exit 1
fi

# Verify source files match expected commit
EXPECTED_COMMIT="fb2f44674f7d80273964ffeca0b95ab1d7d3bd3b"
if [[ "$COMMIT" != "$EXPECTED_COMMIT" ]]; then
  echo "WARNING: Current commit $COMMIT does not match expected $EXPECTED_COMMIT" >&2
  echo "Tests will run against current working tree." >&2
fi

# Test suites and their database names
SUITES=(
  "test-pg-delivery-integration:lwc_pg_delivery_test"
  "test-manual-reply-pg:lwc_pg_reply_test"
  "test-p03-final-pg:lwc_pg_p03_test"
  "test-human-operations-pg:lwc_pg_ops_test"
)

RESULTS=()
CLEANUP_ERRORS=()

cleanup_db() {
  local db_name="$1"
  if docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d postgres -c "DROP DATABASE IF EXISTS $db_name" >/dev/null 2>&1; then
    echo "  [cleanup] Dropped $db_name"
  else
    echo "  [cleanup] FAILED to drop $db_name" >&2
    CLEANUP_ERRORS+=("$db_name")
  fi
}

run_suite() {
  local suite_name="$1"
  local db_name="$2"
  local script_path="scripts/${suite_name}.mjs"

  echo "=== Running $suite_name (database: $db_name) ==="

  # Verify database name ends in _test
  if [[ ! "$db_name" =~ _test$ ]]; then
    echo "  [FAIL] Database name must end in _test: $db_name" >&2
    RESULTS+=("FAIL:$suite_name")
    return 1
  fi

  # Create isolated test database
  if ! docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d postgres -c "CREATE DATABASE $db_name" >/dev/null 2>&1; then
    echo "  [FAIL] Could not create database $db_name" >&2
    RESULTS+=("FAIL:$suite_name")
    return 1
  fi
  echo "  [setup] Created $db_name"

  # Install pgvector if available
  docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$db_name" -c "CREATE EXTENSION IF NOT EXISTS vector" >/dev/null 2>&1 || true

  # Run the test suite
  local test_url="postgresql://${PG_USER}:${PG_PASSWORD}@localhost:5432/${db_name}"
  local output
  output=$(cd "$REPO" && TEST_DATABASE_URL="$test_url" ENCRYPTION_KEY="0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" node "$script_path" 2>&1)
  local exit_code=$?

  echo "$output" | tail -5

  if [[ $exit_code -eq 0 ]]; then
    echo "  [PASS] $suite_name"
    RESULTS+=("PASS:$suite_name")
  else
    echo "  [FAIL] $suite_name (exit code: $exit_code)" >&2
    RESULTS+=("FAIL:$suite_name")
  fi

  # Cleanup
  if [[ "$KEEP_TEST_DB" != "1" ]]; then
    cleanup_db "$db_name"
  else
    echo "  [cleanup] KEEP_TEST_DB=1, keeping $db_name"
  fi

  echo ""
  return $exit_code
}

# Run all suites
for suite_entry in "${SUITES[@]}"; do
  IFS=':' read -r suite_name db_name <<< "$suite_entry"
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
