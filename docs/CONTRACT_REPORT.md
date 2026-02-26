# Contract Comparison Report

- Generated at: 2026-02-23T12:37:33.283Z
- Old backend: `http://127.0.0.1:8000`
- New backend: `http://127.0.0.1:8002`
- Summary: pass=9, warn=0, fail=0

| Case | Method | Route | Old Status | New Status | Result | Notes |
| --- | --- | --- | ---: | ---: | --- | --- |
| health | GET | `/api/health` | 200 | 200 | pass | status and top-level keys compatible |
| auth-status | GET | `/api/v1/auth/status` | 200 | 200 | pass | status and top-level keys compatible |
| analysis-tasks | GET | `/api/v1/analysis/tasks?limit=5` | 200 | 200 | pass | status and top-level keys compatible |
| history-list | GET | `/api/v1/history?page=1&limit=5` | 200 | 200 | pass | status and top-level keys compatible |
| backtest-results | GET | `/api/v1/backtest/results?page=1&limit=5` | 200 | 200 | pass | status and top-level keys compatible |
| system-config | GET | `/api/v1/system/config?include_schema=false` | 200 | 200 | pass | status and top-level keys compatible |
| system-schema | GET | `/api/v1/system/config/schema` | 200 | 200 | pass | status and top-level keys compatible |
| stocks-extract-no-file | POST | `/api/v1/stocks/extract-from-image` | 400 | 400 | pass | status and top-level keys compatible |
| stocks-history-invalid-period | GET | `/api/v1/stocks/600519/history?period=weekly&days=30` | 422 | 422 | pass | status and top-level keys compatible |

## Key Diff Details

### health

- Old keys: `status`, `timestamp`
- New keys: `status`, `timestamp`
- Missing in new: (none)

### auth-status

- Old keys: `authEnabled`, `loggedIn`, `passwordChangeable`, `passwordSet`
- New keys: `authEnabled`, `loggedIn`, `passwordChangeable`, `passwordSet`
- Missing in new: (none)

### analysis-tasks

- Old keys: `pending`, `processing`, `tasks`, `total`
- New keys: `pending`, `processing`, `tasks`, `total`
- Missing in new: (none)

### history-list

- Old keys: `items`, `limit`, `page`, `total`
- New keys: `items`, `limit`, `page`, `total`
- Missing in new: (none)

### backtest-results

- Old keys: `items`, `limit`, `page`, `total`
- New keys: `items`, `limit`, `page`, `total`
- Missing in new: (none)

### system-config

- Old keys: `config_version`, `items`, `mask_token`, `updated_at`
- New keys: `config_version`, `items`, `mask_token`, `updated_at`
- Missing in new: (none)

### system-schema

- Old keys: `categories`, `schema_version`
- New keys: `categories`, `schema_version`
- Missing in new: (none)

### stocks-extract-no-file

- Old keys: `error`, `message`
- New keys: `error`, `message`
- Missing in new: (none)

### stocks-history-invalid-period

- Old keys: `error`, `message`
- New keys: `error`, `message`
- Missing in new: (none)
