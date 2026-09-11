import assert from "node:assert/strict";
import {
  contractVersion,
  createMiddleware,
  currentContext,
  defaultConfig,
  validateConfig,
} from "../dist/index.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function config(service = "flags-2-env-test-bun") {
  const value = defaultConfig(service);
  value.environment = "test";
  value.settings.tls.requireHttps = false;
  value.settings.tls.mode = "disabled";
  value.settings.rateLimit.enabled = false;
  value.settings.compression.enabled = false;
  value.settings.idempotency.enabled = false;
  value.integrations.sharedAuth.mode = "disabled";
  value.integrations.optoSync.mode = "disabled";
  assert.deepEqual(validateConfig(value), []);
  return value;
}

assert.equal(contractVersion, "1.0.0");

// Concurrent AsyncLocalStorage isolation: every downstream handler must see
// only its own request/user/tenant correlation values, even after awaits.
{
  const middleware = createMiddleware(config(), {
    authVerifier: async (request) => ({
      userId: request.headers.get("x-user") ?? undefined,
      tenantId: request.headers.get("x-tenant") ?? undefined,
    }),
  });
  await Promise.all(Array.from({ length: 64 }, async (_, index) => {
    const requestId = `bun-request-${index}`;
    const response = await middleware(
      new Request(`http://127.0.0.1/concurrent/${index}`, {
        headers: {
          accept: "application/json",
          "x-request-id": requestId,
          "x-user": `user-${index}`,
          "x-tenant": `tenant-${index % 7}`,
        },
      }),
      async () => {
        await sleep(index % 5);
        const context = currentContext();
        assert.ok(context);
        assert.equal(context.requestId, requestId);
        assert.equal(context.userId, `user-${index}`);
        assert.equal(context.tenantId, `tenant-${index % 7}`);
        return Response.json({ index, requestId }, { status: 200 });
      },
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-request-id"), requestId);
    assert.deepEqual(await response.json(), { index, requestId });
  }));
  assert.equal(currentContext(), undefined);
}

// Invalid externally supplied request IDs are never reflected verbatim.
{
  const middleware = createMiddleware(config());
  const response = await middleware(
    new Request("http://127.0.0.1/request-id", {
      headers: { accept: "application/json", "x-request-id": "bad request id\n" },
    }),
    async () => Response.json({ ok: true }),
  );
  const requestId = response.headers.get("x-request-id");
  assert.ok(requestId);
  assert.notEqual(requestId, "bad request id\n");
  assert.match(requestId, /^[A-Za-z0-9._-]+$/);
}

// Declared oversized bodies fail before downstream dispatch.
{
  const value = config();
  value.settings.maxBodyBytes = 4;
  let called = false;
  const middleware = createMiddleware(value);
  const response = await middleware(
    new Request("http://127.0.0.1/body", {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "content-length": "5",
      },
      body: "12345",
    }),
    async () => {
      called = true;
      return Response.json({ impossible: true });
    },
  );
  assert.equal(response.status, 413);
  assert.equal(called, false);
}

// Forwarded transport metadata from an untrusted peer is rejected.
{
  const value = config();
  value.settings.tls.strictForwardedHeaders = true;
  const middleware = createMiddleware(value);
  const response = await middleware(
    new Request("http://127.0.0.1/proxy", {
      headers: { accept: "application/json", "x-forwarded-proto": "https" },
    }),
    async () => Response.json({ impossible: true }),
  );
  assert.equal(response.status, 400);
}

// A service-provided limiter can deny deterministically before dispatch.
{
  const value = config();
  value.settings.rateLimit.enabled = true;
  const middleware = createMiddleware(value, {
    rateLimiter: { allow: async () => false },
  });
  const response = await middleware(
    new Request("http://127.0.0.1/limited", { headers: { accept: "application/json" } }),
    async () => Response.json({ impossible: true }),
  );
  assert.equal(response.status, 429);
}

// Enabling Shared Auth without establishing a user fails closed.
{
  const value = config();
  value.integrations.sharedAuth.mode = "embedded";
  const middleware = createMiddleware(value, { authVerifier: async () => ({}) });
  const response = await middleware(
    new Request("http://127.0.0.1/protected", { headers: { accept: "application/json" } }),
    async () => Response.json({ impossible: true }),
  );
  assert.equal(response.status, 401);
}

// Deadlines are enforced around downstream async work.
{
  const value = config();
  value.settings.timeoutMs = 5;
  const middleware = createMiddleware(value);
  const response = await middleware(
    new Request("http://127.0.0.1/slow", { headers: { accept: "application/json" } }),
    async () => {
      await sleep(40);
      return Response.json({ tooLate: true });
    },
  );
  assert.equal(response.status, 504);
}

// Idempotent POST replay must not invoke the downstream handler twice.
{
  const value = config();
  value.settings.idempotency.enabled = true;
  let calls = 0;
  const middleware = createMiddleware(value);
  const invoke = () => middleware(
    new Request("http://127.0.0.1/replay", {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "idempotency-key": "bun-replay-key",
      },
      body: "{}",
    }),
    async () => {
      calls += 1;
      return Response.json({ calls });
    },
  );
  const first = await invoke();
  const second = await invoke();
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.deepEqual(await first.json(), { calls: 1 });
  assert.deepEqual(await second.json(), { calls: 1 });
  assert.equal(calls, 1);
}

// Production-only safety invariants must remain executable, not prose.
{
  const value = defaultConfig("bun-production-negative-control");
  value.environment = "production";
  value.settings.faultInjection.enabled = true;
  value.settings.testAuthBypass.enabled = true;
  const codes = validateConfig(value).map((issue) => issue.code);
  assert.ok(codes.filter((code) => code === "production_forbidden").length >= 2);
}

console.log(JSON.stringify({
  runtime: "bun",
  contractVersion,
  concurrentRequests: 64,
  adversarialControls: 8,
  passed: true,
}));
