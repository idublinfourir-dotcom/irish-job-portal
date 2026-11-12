#!/bin/sh
# usage: test-db.sh up|down
# Starts or stops the test database: Supabase's Postgres 17 image, on 127.0.0.1 only, fake data only.
# Keep the image tag in step with .github/workflows/check.yml.
set -e
RUN="${CONTAINER:-podman}"
NAME=portal-test-db
IMAGE=docker.io/supabase/postgres:17.11.0.018
PORT=54329

case "$1" in
  up)
    "$RUN" rm -f "$NAME" >/dev/null 2>&1 || true
    "$RUN" run -d --name "$NAME" --cpus 8 --memory 4g -p "127.0.0.1:$PORT:5432" -e POSTGRES_PASSWORD=test "$IMAGE" >/dev/null
    # The image starts a temporary server first and restarts, so wait for a TCP answer, not just any answer.
    i=0
    until "$RUN" exec "$NAME" pg_isready -h 127.0.0.1 -U postgres -q; do
      i=$((i + 1)); [ "$i" -gt 60 ] && { echo "test database did not start" >&2; exit 1; }
      sleep 1
    done
    # Throwaway data: commits skip the disk wait. With it on, the full suite's write-path time budgets failed at random under parallel load.
    "$RUN" exec "$NAME" psql -q -U supabase_admin -d postgres -c "alter system set fsync = off" -c "alter system set synchronous_commit = off" \
      -c "alter system set full_page_writes = off" -c "select pg_reload_conf()" >/dev/null
    echo "test database ready: postgres://postgres:test@127.0.0.1:$PORT/postgres"
    ;;
  down) "$RUN" rm -f "$NAME" >/dev/null ;;
  *) echo "usage: $0 up|down" >&2; exit 1 ;;
esac
