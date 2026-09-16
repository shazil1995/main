#!/bin/sh
set -e

echo "Applying database migrations..."
(cd packages/db && npx prisma migrate deploy)

exec "$@"
