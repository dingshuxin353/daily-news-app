# DailyNews M0 MCP compatibility validation report

Status: completed under the narrowed validation scope

Validation date: 2026-08-22

Evidence scope: Inspector baseline and Codex desktop manual compatibility only

## Scope decision

On 2026-08-22, the maintainer narrowed this M0 MCP validation subtask after
Codex C01-C10 completed. WorkBuddy and Hermes client validation, and all phase D
scheduled-task validation, were stopped and left unverified. This scope change
does not mean those clients or scheduled execution are compatible, and it does
not complete the overall M0 milestone.

## Fixed baseline

| Component | Validated version or value |
| --- | --- |
| Endpoint | `https://ai.weijennie.com/mcp-test` (removed after validation) |
| MCP protocol | `2025-11-25` |
| Probe | commit `17218f1d918dfa0a6b04054adb6a5eb310f54b9d` |
| MCP TypeScript SDK | `1.30.0` |
| MCP Inspector | `2.3.0` |
| Codex desktop | `26.818.22352` (build 6872) |
| Codex CLI | `0.146.0`, auxiliary diagnostics only |
| Server Node.js | `25.5.0` |
| Server npm | `11.8.0` |
| Nginx | `1.26.3` |
| Server OS | OpenCloudOS 9.4 |

## Probe implementation checks

- `dailynews_submit_probe` exposes the complete public Candidate JSON Schema,
  including `clientRunId` type, length, pattern, nested required fields, enums,
  and arrays. Automated tests assert the actual `tools/list` response.
- Candidate validation and operational logs retain only approved metadata and
  do not echo the submitted Candidate or authorization value.
- Final local checks passed: `npm test` 66/66, `npm run build`, dedicated probe
  tests 11/11 on Node.js `24.19.0`, and probe tests 11/11 on Node.js `22.23.2`.
- The deployed probe also passed its 11/11 dedicated tests before client
  validation. The protocol-negotiation correction is commit `17218f1` on
  `test/mcp-compatibility`.

## Verified facts

### Inspector HTTPS baseline

The pinned Inspector connected directly to the public HTTPS endpoint and
negotiated MCP `2025-11-25`. It discovered the three probe tools, submitted and
read back the fixed Candidate, observed idempotent duplicate behavior, and
received a visible validation error for invalid input.

| Operation | Server request ID or receipt ID |
| --- | --- |
| Context | `52341bd1-f32e-4cc1-b77c-cadf305efd9e` |
| First submit | `f9b2a59d-a64f-4c31-982e-6f774af5e288` |
| Duplicate submit | `63443caf-e33c-42df-891c-7f83f46993c3` |
| Receipt read | request `bdd95603-6239-4dbc-91c5-beed8a6f9965`; receipt `55964a93-568f-4836-a66c-53d704365500` |
| Invalid input | `99fe0127-6569-4b5b-a64b-de350acbb8e5` (`validation_error`) |

The Inspector token was revoked immediately after this baseline.

### Codex desktop C01-C10

All calls below used the real `dailynews_probe` MCP integration in Codex
desktop. Codex CLI did not substitute for the client calls.

| Case | Result | Evidence |
| --- | --- | --- |
| C01 Configure remote MCP and token source | Passed | Remote Streamable HTTP configuration used an environment variable token source and no local proxy. |
| C02 Discover tools after restart | Passed | `tools/list` request `2a5ca8fb-27c7-4ff9-886d-114038a27590`; exactly three probe tools were available. |
| C03 Read probe context | Passed | request `b030cf33-50e8-491b-bee9-9d297e85afb6`; `clientId=codex`, protocol `2025-11-25`. |
| C04 Submit fixed Candidate | Passed | request `ba3483bd-deb5-41e5-b181-73b34cc601f7`; receipt `a85b177c-8f0b-491a-b3f9-033f60d7a515`, `duplicate=false`. |
| C05 Repeat identical submission | Passed | request `7398ab97-8694-4245-9377-d9561b262be8`; same receipt, `duplicate=true`. |
| C06 Read receipt | Passed | request `acd13dbf-ee37-4a81-ae6b-a3d0ef2544d0`; the complete Unicode and nested Candidate matched. |
| C07 Submit invalid parameters | Passed | request `949d3ba5-9252-4afd-8471-889bbd8b9400`; visible `-32602` error and server `validation_error`. |
| C08 Recover after service restart | Passed | request `9bf013b3-742b-4474-aa19-2cc1441e6da1`; the current client reconnected. Old in-memory receipt lookup `8335e38a-9e00-4e9b-900b-b98cea50c38a` returned `not_found` as designed. |
| C09 Reject a revoked token | Passed | request `2c30203b-4219-43d6-a467-0750fc134a96`; authentication failed and no cached permission survived. |
| C10 Recover with a newly issued token | Passed | initialize `aa018935-eb88-4c7a-9a45-5a1d0c8ea084`, tools/list `990feddd-689a-459e-a7b6-b6b05b2b17ab`, context `2f3f2ee8-e375-40b9-a5de-af8d11bc5628`, submit `3c0215ec-46ef-450a-b467-7b758c8e29ca`, receipt read `13bded87-1315-4748-9290-1abcfc000eba`; final receipt `86451a3d-84fd-4c49-b51f-329fdff7ee78`. |

Conclusion: **Codex manual remote MCP compatibility is verified. Scheduled
execution is not verified.** Under the original grading rules, Codex cannot be
graded A without phase D.

## Unverified clients and capabilities

| Client or capability | Result |
| --- | --- |
| Codex scheduled task | Not validated; no compatibility claim. |
| WorkBuddy C01-C10 | Not validated; test later only if needed. |
| WorkBuddy scheduled task | Not validated; no compatibility claim. |
| Hermes C01-C10 | Not validated; test later only if needed. |
| Hermes scheduled task | Not validated; no compatibility claim. |

WorkBuddy and Hermes are not recorded as passed, compatible, or supported for
the first release by this report.

## Security and cleanup

- The report, repository, service logs, and screenshots contain no raw token.
- All current Inspector, Codex, WorkBuddy, and Hermes token digests were added
  to the revoked set before shutdown. A current Codex token then returned HTTP
  `401`.
- The probe service was stopped and disabled. Port `4317` is no longer
  listening.
- The exact Nginx `/mcp-test` route was removed by restoring the pre-test
  configuration. `nginx -t` passed and Nginx remained active.
- The restored site configuration SHA-256 is
  `ba6d3df67267f63e111f1d149cf8e31b272ad617b1062c3bab3d6fd2c5734e4f`.
- After cleanup, `/mcp-test` returned `404`; the existing `/` and
  `/course-materials/` baselines remained `403` and `200` respectively.
- No public application port was added. Public HTTP/HTTPS remained on ports
  `80` and `443`.
- Local raw credential and launcher artifacts were deleted and the temporary
  launch environment value was unset.

## Overall M0 status

This report closes only the narrowed M0 MCP validation subtask. The overall M0
milestone remains incomplete. In particular, the email verification library,
mail delivery service, real mailbox delivery result, and confirmed
`spec-v1.0.0.md` are still outstanding. Unvalidated client and scheduled-task
capabilities cannot be used as compatibility evidence.
