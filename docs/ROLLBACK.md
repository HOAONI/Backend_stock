# Rollback

1. Switch gateway route back to the legacy Python backend.
2. Keep Backend_stock stopped for write traffic.
3. Inspect PostgreSQL write logs and migration checkpoints.
4. Fix issue and re-run canary traffic.
