# End-to-End Validation Report

- Generated at: 2026-02-23T12:38:04.894Z
- Base URL: `http://127.0.0.1:8002`
- Stock code: `600519`
- Summary: pass=24, warn=0, fail=0

| Check | Result | Detail |
| --- | --- | --- |
| health | pass | status=200 |
| auth-status-initial | pass | status=200, authEnabled=true, passwordSet=false |
| auth-first-login-mismatch | pass | status=400 |
| auth-login | pass | status=200 |
| auth-status-logged-in | pass | status=200, loggedIn=true |
| analysis-async-submit | pass | status=202, taskId=046d6f222c794a4f9c8e5541ab86f23e |
| analysis-duplicate-guard | pass | status=409 |
| analysis-async-terminal | pass | task reached failed (terminal status accepted in non-strict mode) |
| analysis-sse-sequence | pass | events=message, connected, task_created, task_started, heartbeat, heartbeat, task_failed, heartbeat, heartbeat, heartbeat, heartbeat, heartbeat, heartbeat, heartbeat, heartbeat |
| analysis-sse-terminal-event | pass | events=message, connected, task_created, task_started, heartbeat, heartbeat, task_failed, heartbeat, heartbeat, heartbeat, heartbeat, heartbeat, heartbeat, heartbeat, heartbeat |
| analysis-task-list | pass | status=200 |
| history-list | pass | status=200 |
| history-detail | pass | status=404 |
| history-news | pass | status=200 |
| system-config-get | pass | status=200 |
| system-config-schema | pass | status=200 |
| system-config-validate | pass | status=200 |
| system-config-version-conflict | pass | status=409 |
| backtest-results | pass | status=200 |
| backtest-performance | pass | status=404 |
| stocks-invalid-period | pass | status=422 |
| stocks-extract-no-file | pass | status=400 |
| auth-logout | pass | status=204 |
| auth-protected-after-logout | pass | status=401 |
