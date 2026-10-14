# bugfix-app

The sample app with a known bug, for the AI-DLC bugfix run in
`docs/manual-runs.md`: `GET /sum?a=1&b=2` answers `{"sum":"12"}` because the
query values are strings. `test/sum.test.js` shows it, so `npm test` fails
until the bug is fixed.
