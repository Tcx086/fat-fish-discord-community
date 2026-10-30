# Official WeChat adapter specification

**WECHAT_EXTERNAL_SETUP_REQUIRED**. No verified account eligibility, credentials,
public callback, personal-account automation or real message transport is present.
Implemented code is a contract with cryptographic/normalized-message fixtures, not
a claim that a WeChat account is connected.

## Feasibility and evidence

Research date: 2026-10-29, America/New_York.

| Route | Prerequisites and practical scope |
| --- | --- |
| Official Account | Register an appropriate subscription/service account at `mp.weixin.qq.com`; verify the account's API entitlement and administrator ownership. AppID/AppSecret, original account ID, callback token and EncodingAESKey are needed. User OpenID is account-scoped. Suitable for user-initiated one-to-one text within the account's response rules. |
| WeChat Customer Service | Register/verify the organization and customer-service account; obtain CorpID, authorized Secret and `open_kfid`, configure callbacks and permitted calling application/IPs. `external_userid` is the customer identity, not an employee userid. Suitable for external WeChat users initiating service conversations. |
| WeCom internal application | CorpID, AgentID, application Secret and scoped employee access. Internal employee messages differ from external WeChat customer conversations; do not substitute this API for general personal WeChat chat. |

Tencent's current [Official Account integration guide](https://cloud.tencent.cn/document/product/1759/120123)
confirms service/subscription account integrations, AppID and administrator approval.
It explicitly identifies certification as necessary for its asynchronous reply path
after five seconds. This is evidence for that integration path, not a claim that
every account has identical entitlement.

Tencent's [Customer Service integration guide](https://cloud.tencent.cn/document/product/1759/122567)
describes organization ID, URL/Token/EncodingAESKey setup, subsequent Secret retrieval
and selecting a customer-service account. It documents domain/organization
verification requirements. The [official Yuanqi guide](https://yuanqi.tencent.com/guide/publish-agent-publish-wechat-service)
also requires customer-service registration/certification before callback setup.
Together these support feasibility, subject to this user's account eligibility.

The direct WeChat protocol pages below could not be retrieved by the research tool
in this session. They are the required verification checklist before implementing a
real transport; current endpoint entitlements and numeric quotas remain external
setup checks, not experimentally verified properties of this implementation:

- [Official Account access](https://developers.weixin.qq.com/doc/offiaccount/Basic_Information/Access_Overview.html)
- [Incoming messages](https://developers.weixin.qq.com/doc/offiaccount/Message_Management/Receiving_standard_messages.html)
- [Official Account customer-service responses](https://developers.weixin.qq.com/doc/offiaccount/Message_Management/Service_Center_messages.html)
- [WeCom callback cryptography](https://developer.work.weixin.qq.com/document/path/90968)
- [Customer Service message/event sync](https://developer.work.weixin.qq.com/document/path/94670)
- [Customer Service send message](https://developer.work.weixin.qq.com/document/path/94677)

The design conservatively assumes a user-initiated 48-hour customer-service reply
window and a maximum of five consecutive replies, reset only by a new eligible
customer message. Tencent's [customer-service training material](https://training.tencentads.com/uploads/202409/aTxHiT6N_YrvUZM.pdf)
describes the five/48-hour rule (search-index evidence; full PDF retrieval timed out).
Recheck live official-account and customer-service rules separately: they are not
interchangeable. No outbound code relies on an unverified quota. Aggregate API rate
limits vary by endpoint/account; obtain them from the approved account portal and
the linked references. Until then outbound capability is denied, not unlimited.

## Incoming and outgoing contract

The future transport must authenticate the platform envelope before constructing
the core interaction documented in [V0_2_ARCHITECTURE.md](V0_2_ARCHITECTURE.md).
Permissions come from server configuration plus current consent, never XML/JSON
fields or model output. IDs are namespaced by platform and owning app/organization.

### Official Account

1. Receive bounded HTTPS callbacks. Reject oversize bodies before XML parsing;
   reject DTDs/entities, duplicate fields, unsupported message types and bad signatures.
2. Verify sorted SHA-1 token/timestamp/nonce for the plaintext GET challenge;
   require encrypted safe-mode bodies for message processing. Safe-mode signature
   includes the ciphertext. Constant-time comparison precedes AES-256-CBC decryption.
3. Validate 32-byte PKCS#7 padding, random-prefix/length frame, expected AppID receiver,
   account recipient, timestamp and configured user access. Never fall back to plaintext
   after encrypted verification fails. Protect token/AES key like API credentials.
4. Normalize `FromUserName`, `MsgId`, `CreateTime`, `Content` to `wechat-official`,
   account ID as guild scope, OpenID as channel/user, and a transport session ID.
5. A real service must acknowledge promptly (under five seconds) and queue generation;
   model/search latency must not hold the webhook open. Use the approved customer-service
   send API when eligible. Otherwise do not attempt a delayed unsolicited reply.

### Customer Service / WeCom

1. Verify/decrypt callbacks with the expected CorpID and safe-mode signature.
   Notifications are not user messages: `kf_msg_or_event` provides a sync token/account.
2. Through a fixed, authenticated HTTPS transport call
   `POST https://qyapi.weixin.qq.com/cgi-bin/kf/sync_msg?access_token=...` with the
   event token, persisted cursor, bounded limit and authorized `open_kfid`.
   Access-token acquisition uses the authorized CorpID/Secret. Redact URLs containing
   access tokens; never print request URLs/headers on transport failure.
3. Persist progress per account. Advance the cursor only with durably claimed messages.
   Normalize customer-origin (`origin:3`) `msgtype:text` records, `msgid`,
   `external_userid`, `send_time` and `text.content`. Ignore agent/system-origin
   messages to avoid reply loops. Use `wechat-kf`, CorpID and `open_kfid` scopes.
4. Outbound text uses the authorized `kf/send_msg` API with `touser`, `open_kfid`,
   `msgtype:text`, text content and a stable outgoing message ID where supported.
   Confirm the current official schema and response policy before enabling it.
   Internal WeCom `message/send` is a distinct application/employee route.

### Delivery and operating requirements

- Require a publicly reachable HTTPS endpoint and certificate, verified domain and
  hosting allowed by the account's organization/region. Complete any applicable
  domain/filing/egress-IP requirements through the real portal; none was provisioned.
- Keep credentials in a secret store/process environment; cache access tokens only
  for their returned lifetime. Separate account token-refresh and message quotas.
- Apply verified endpoint quotas plus a stricter local limiter: proposed starting
  cap one outgoing message/second/account, five per eligible customer window, and
  bounded queue depth 100. These are local safety caps, not asserted platform quotas.
- Enforce the response window and message count before reserving output. Stop on
  permission/rate/window errors. Retry only documented transient errors within a
  bounded budget; never blindly retry an ambiguous accepted send using a new ID.
- A real deployment requires a persistent inbox/outbox with states `claimed`,
  `generated`, `send_reserved`, `sent`/`failed`; commit cursor and inbox claims
  transactionally. Exactly-once network delivery is not promised.
- The delivered core reserves message IDs for 24 hours and suppresses duplicates
  across restarts. It intentionally stores no response cache, so a crash after claim
  may lose the response. This is sufficient for fixtures/local commands; the durable
  webhook queue/outbox remains part of the externally gated transport specification.
- Show policy/retention notice before `/consent`; require approved facts, not
  inferred profiles. Linking requires control of both accounts through the expiring
  challenge. It grants only explicit private fact retrieval, never Discord transcripts.
  Provide `/unlink` and `/withdraw` in both authenticated interfaces.

## What is implemented and how to test

`wechat-adapter.js` contains signature/decryption/frame validation, a deliberately
restricted flat XML text parser, an encrypted Official Account fixture adapter, and
a WeCom authenticated-sync-result fixture adapter. It creates no network listener
and contains no token-fetching/sending code. `createWecomFixtureAdapter` must never
be exposed directly to unverified webhook JSON.

`npm run test:v02` tests synthetic AES/signature challenges, altered signatures,
wrong receivers, stale timestamps, XML entities/duplicate fields, allowlists,
normalized stable IDs, unsupported origins and duplicate callback suppression.
These are local protocol fixtures, not certification against a real account.

External setup must supply verified eligibility/administrator ownership, selected
route, allowed account/user IDs, approved public hosting, credentials and current
quota/response rules. Then implement and review the transport/outbox above, obtain
separate connection authorization, and run one synthetic user-initiated exchange
plus a duplicate callback. Core memory/search work is complete without that setup.
There is no official general-purpose personal-account bot assumption and no
reverse-engineered login, injection or client-control fallback.
