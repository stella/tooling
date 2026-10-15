import http from "node:http";
import net, {
  connect as connectNet,
  createConnection as createNetConnection,
} from "node:net";
import tls, { connect as connectTls } from "node:tls";

import {
  NetworkAccessError,
  installNetworkGuard,
  isLoopbackHost,
} from "../src/network.js";
import { serve } from "./network-server.js";
import { rejectionOf } from "./rejection.js";
import { afterEach, describe, expect, spyOn, test } from "./runner.js";

const servers: Awaited<ReturnType<typeof serve>>[] = [];
const startServer: typeof serve = async (handler) => {
  const server = await serve(handler);
  servers.push(server);
  return server;
};

let uninstall: (() => void) | undefined;

// What a fake fetch was asked for, whichever input form it received.
const requestedUrl = (input: unknown): string => {
  if (input instanceof Request) {
    return input.url;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return typeof input === "string" ? input : "(not a URL)";
};
afterEach(async () => {
  uninstall?.();
  uninstall = undefined;
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("loopback hosts", () => {
  test.each([
    "localhost",
    "LOCALHOST",
    "api.localhost",
    "127.0.0.1",
    "127.10.0.3",
    "::1",
    "[::1]",
    "::ffff:127.0.0.1",
    new URL("http://[::ffff:127.0.0.1]/").hostname,
    "[::ffff:7f12:3456]",
  ])("%s is local", (host) => {
    expect(isLoopbackHost(host)).toBe(true);
  });

  test.each([
    "example.com",
    "localhost.example.com",
    "128.0.0.1",
    "10.0.0.1",
    "::2",
    new URL("http://[::ffff:10.0.0.1]/").hostname,
    "[::ffff:8000:1]",
    "",
  ])("%s is not local", (host) => {
    expect(isLoopbackHost(host)).toBe(false);
  });
});

describe("network guard", () => {
  test("fetch to a remote host rejects before any request", async () => {
    uninstall = installNetworkGuard({ environment: {} });
    const error = await rejectionOf(fetch("https://example.com/x"));
    expect(error).toBeInstanceOf(NetworkAccessError);
    expect(error).toHaveProperty("host", "example.com");
  });

  test("fetch to a loopback server still works", async () => {
    uninstall = installNetworkGuard({ environment: {} });
    const server = await startServer((_request, response) =>
      response.end("ok"),
    );
    const response = await fetch(`http://127.0.0.1:${String(server.port)}/`);
    expect(await response.text()).toBe("ok");
  });

  test("only an explicitly allowed host passes the guard", async () => {
    const realFetch = globalThis.fetch;
    const reached: string[] = [];
    // A fake underneath the guard: nothing leaves the process.
    Reflect.set(globalThis, "fetch", async (input: unknown) => {
      reached.push(requestedUrl(input));
      return new Response("ok");
    });
    try {
      uninstall = installNetworkGuard({
        allowHosts: ["Postgres"],
        environment: {},
      });
      expect(await (await fetch("http://postgres:5432/")).text()).toBe("ok");
      expect(
        await rejectionOf(fetch("http://postgres.example/")),
      ).toBeInstanceOf(NetworkAccessError);
      expect(reached).toEqual(["http://postgres:5432/"]);
    } finally {
      uninstall?.();
      uninstall = undefined;
      Reflect.set(globalThis, "fetch", realFetch);
    }
  });

  describe("redirects", () => {
    const serveRedirects = () =>
      startServer(async (request, response) => {
        const { pathname } = new URL(request.url ?? "/", "http://localhost");
        switch (pathname) {
          case "/away":
            response
              .writeHead(302, { location: "http://example.com/elsewhere" })
              .end();
            return;
          case "/hop":
            response.writeHead(307, { location: "/final" }).end();
            return;
          case "/permanent":
            response.writeHead(308, { location: "/final" }).end();
            return;
          case "/double-hop":
            response.writeHead(307, { location: "/hop" }).end();
            return;
          case "/see-other":
            response.writeHead(303, { location: "/final" }).end();
            return;
          case "/final": {
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(Buffer.from(chunk));
            response.end(
              `${request.method} ${Buffer.concat(chunks).toString()}`,
            );
            return;
          }
          default:
            response.writeHead(404).end("missing");
        }
      });

    test("a loopback redirect to a remote host is refused", async () => {
      uninstall = installNetworkGuard({ environment: {} });
      const server = await serveRedirects();
      const error = await rejectionOf(
        fetch(`http://127.0.0.1:${String(server.port)}/away`),
      );
      expect(error).toBeInstanceOf(NetworkAccessError);
      expect(error).toHaveProperty("host", "example.com");
    });

    test("local redirects are followed with their method and body rules", async () => {
      uninstall = installNetworkGuard({ environment: {} });
      const server = await serveRedirects();
      const base = `http://127.0.0.1:${String(server.port)}`;
      const kept = await fetch(`${base}/hop`, { body: "x", method: "POST" });
      expect(await kept.text()).toBe("POST x");
      expect(kept.url).toBe(`${base}/final`);
      const switched = await fetch(`${base}/see-other`, {
        body: "x",
        method: "POST",
      });
      expect(await switched.text()).toBe("GET ");
    });

    test.each(["/hop", "/permanent", "/double-hop"])(
      "a Request body refuses replay at %s with an actionable error",
      async (pathname) => {
        uninstall = installNetworkGuard({ environment: {} });
        const server = await serveRedirects();
        const request = new Request(
          `http://127.0.0.1:${String(server.port)}${pathname}`,
          {
            method: "POST",
            body: "payload",
          },
        );
        expect(String(await rejectionOf(fetch(request)))).toContain(
          "pass the body in init",
        );
      },
    );

    test.each(["/hop", "/permanent", "/double-hop"])(
      "an init body replays across the redirect at %s",
      async (pathname) => {
        uninstall = installNetworkGuard({ environment: {} });
        const server = await serveRedirects();
        const base = `http://127.0.0.1:${String(server.port)}`;
        const response = await fetch(`${base}${pathname}`, {
          method: "POST",
          body: "payload",
        });
        expect(await response.text()).toBe("POST payload");
        expect(response.url).toBe(`${base}/final`);
      },
    );

    test("a Request body dropped by a 303 follows as a bodyless GET", async () => {
      uninstall = installNetworkGuard({ environment: {} });
      const server = await serveRedirects();
      const request = new Request(
        `http://127.0.0.1:${String(server.port)}/see-other`,
        {
          method: "POST",
          body: "payload",
        },
      );
      const response = await fetch(request);
      expect(await response.text()).toBe("GET ");
    });

    test("a streamed upload is not buffered before the request starts", async () => {
      uninstall = installNetworkGuard({ environment: {} });
      const server = await startServer((request, response) => {
        // Answers on the first chunk, while the upload is still open.
        request.once("data", (chunk) => response.end(chunk));
      });
      const upload = new TransformStream<Uint8Array, Uint8Array>();
      const writer = upload.writable.getWriter();
      const init = {
        body: upload.readable,
        duplex: "half",
        method: "POST",
      };
      const responding = fetch(
        `http://127.0.0.1:${String(server.port)}/`,
        init,
      );
      await writer.write(new TextEncoder().encode("first"));
      const response = await responding;
      // The response arrived while the upload was still open.
      expect(await response.text()).toBe("first");
      await writer.close().catch(() => undefined);
      writer.releaseLock();
    });

    test("a streaming Request upload is consumed once by the transport without cloning", async () => {
      const chunks = ["first", "second", "third"];
      let pulls = 0;
      const upload = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            const chunk = chunks.at(pulls);
            pulls += 1;
            if (chunk === undefined) controller.close();
            else controller.enqueue(new TextEncoder().encode(chunk));
          },
        },
        { highWaterMark: 0 },
      );
      const server = await startServer(async (request, response) => {
        const received: Buffer[] = [];
        for await (const chunk of request) received.push(Buffer.from(chunk));
        response.end(Buffer.concat(received));
      });
      const init = {
        body: upload,
        duplex: "half",
        method: "POST",
      };
      const request = new Request(
        `http://127.0.0.1:${String(server.port)}/`,
        init,
      );
      const clone = spyOn(request, "clone");
      try {
        expect(pulls).toBe(0);
        uninstall = installNetworkGuard({ environment: {} });
        const response = await fetch(request);
        expect(await response.text()).toBe(chunks.join(""));
        expect(pulls).toBe(chunks.length + 1);
        expect(request.bodyUsed).toBe(true);
        expect(clone).not.toHaveBeenCalled();
      } finally {
        clone.mockRestore();
      }
    });

    describe("under a recording fake", () => {
      type Call = { url: string; init: RequestInit | undefined };
      const withFake = async (
        answer: (call: Call, index: number) => Response,
        body: (calls: Call[]) => Promise<void>,
      ) => {
        const realFetch = globalThis.fetch;
        const calls: Call[] = [];
        Reflect.set(
          globalThis,
          "fetch",
          async (input: unknown, init?: RequestInit) => {
            const call = {
              init,
              url: requestedUrl(input),
            };
            calls.push(call);
            return answer(call, calls.length - 1);
          },
        );
        try {
          uninstall = installNetworkGuard({ environment: {} });
          await body(calls);
        } finally {
          uninstall?.();
          uninstall = undefined;
          Reflect.set(globalThis, "fetch", realFetch);
        }
      };
      const redirectOnce = (status: number) => (_call: Call, index: number) =>
        index === 0
          ? new Response(null, { headers: { location: "/next" }, status })
          : new Response("done");

      test.each([
        ["myMethod", "myMethod"],
        ["post", "POST"],
        ["dElEtE", "DELETE"],
        ["get", "GET"],
        ["head", "HEAD"],
        ["options", "OPTIONS"],
        ["put", "PUT"],
        ["patch", "patch"],
      ])(
        "a 307 preserves fetch method normalization for %s",
        async (method, expected) => {
          await withFake(redirectOnce(307), async (calls) => {
            await fetch("https://localhost:8443/start", { method });
            // The transport normalizes each hop's Request before sending it.
            expect(
              calls.map((call) => new Request(call.url, call.init).method),
            ).toEqual([expected, expected]);
            expect(calls[1]?.init?.method).toBe(expected);
          });
        },
      );

      test("every hop keeps the caller's transport options", async () => {
        await withFake(redirectOnce(307), async (calls) => {
          const tlsOptions = { rejectUnauthorized: false };
          const init = { body: "payload", method: "PUT", tls: tlsOptions };
          await fetch("https://localhost:8443/start", init);
          expect(calls.map((call) => call.url)).toEqual([
            "https://localhost:8443/start",
            "https://localhost:8443/next",
          ]);
          for (const call of calls) {
            expect(Reflect.get(call.init ?? {}, "tls")).toBe(tlsOptions);
            expect(call.init?.redirect).toBe("manual");
          }
          expect(calls[1]?.init?.body).toBe("payload");
          expect(calls[1]?.init?.method).toBe("PUT");
        });
      });

      test("an upload stream is handed on as is, never copied", async () => {
        await withFake(
          () => new Response("ok"),
          async (calls) => {
            const upload = new ReadableStream<Uint8Array>();
            await fetch("http://127.0.0.1:1/", {
              body: upload,
              method: "POST",
            });
            expect(calls[0]?.init?.body).toBe(upload);
            expect(upload.locked).toBe(false);
          },
        );
      });

      test("a Request's signal still cancels the hops after a redirect", async () => {
        await withFake(redirectOnce(307), async (calls) => {
          const controller = new AbortController();
          const request = new Request("http://127.0.0.1:1/start", {
            signal: controller.signal,
          });
          await fetch(request);
          expect(calls).toHaveLength(2);
          expect(calls[1]?.init?.signal).toBe(request.signal);
          controller.abort();
          expect(calls[1]?.init?.signal?.aborted).toBe(true);
        });
      });

      test("a streamed POST dropped by a 303 can follow a later 307", async () => {
        const statuses = [303, 307];
        await withFake(
          (_call, index) => {
            const status = statuses[index];
            return status === undefined
              ? new Response("done")
              : new Response(null, {
                  headers: { location: `/hop-${index}` },
                  status,
                });
          },
          async (calls) => {
            const response = await fetch("http://127.0.0.1:1/", {
              body: new ReadableStream<Uint8Array>(),
              method: "POST",
            });
            expect(await response.text()).toBe("done");
            expect(calls.map((call) => call.init?.method ?? "POST")).toEqual([
              "POST",
              "GET",
              "GET",
            ]);
            expect(calls[2]?.init?.body).toBeNull();
          },
        );
      });

      test("a dropped body takes its request-body headers with it", async () => {
        await withFake(redirectOnce(303), async (calls) => {
          await fetch("http://127.0.0.1:1/", {
            body: "compressed",
            headers: {
              "content-encoding": "gzip",
              "content-language": "cs",
              "content-location": "/doc",
              "content-type": "text/plain",
              "x-trace": "kept",
            },
            method: "POST",
          });
          const redirected = new Headers(calls[1]?.init?.headers);
          expect([...redirected.keys()]).toEqual(["x-trace"]);
        });
      });

      test("a GET or HEAD meeting a 303 keeps its method and headers", async () => {
        for (const method of ["GET", "HEAD"]) {
          await withFake(redirectOnce(303), async (calls) => {
            await fetch("http://127.0.0.1:1/", {
              headers: { "content-language": "cs" },
              method,
            });
            expect(calls[1]?.init?.method).toBe(method);
            const redirected = new Headers(calls[1]?.init?.headers);
            expect(redirected.get("content-language")).toBe("cs");
          });
        }
      });

      test("a 307 cannot resend a streamed body", async () => {
        await withFake(redirectOnce(307), async (calls) => {
          const error = await rejectionOf(
            fetch("http://127.0.0.1:1/", {
              body: new ReadableStream<Uint8Array>(),
              method: "POST",
            }),
          );
          expect(String(error)).toContain("cannot resend a streamed body");
          expect(calls).toHaveLength(1);
        });
      });
    });

    test("a remote proxy is refused even for a loopback target", async () => {
      uninstall = installNetworkGuard({ environment: {} });
      for (const proxy of [
        "http://proxy.example:8080",
        { url: "http://proxy.example:8080" },
      ]) {
        const init: RequestInit = {};
        Reflect.set(init, "proxy", proxy);
        const error = await rejectionOf(fetch("http://127.0.0.1:1/", init));
        expect(error).toBeInstanceOf(NetworkAccessError);
        expect(error).toHaveProperty("host", "proxy.example");
      }
    });

    test.skipIf(typeof globalThis.Bun !== "undefined")(
      "Node refuses a remote URL even when init.unix is set",
      async () => {
        const original = globalThis.fetch;
        const reached: string[] = [];
        // Keep the regression safe even when the guard is deliberately broken.
        Reflect.set(globalThis, "fetch", async (input: unknown) => {
          reached.push(requestedUrl(input));
          return new Response("unguarded");
        });
        try {
          uninstall = installNetworkGuard({ environment: {} });
          const init: RequestInit = {};
          Reflect.set(init, "unix", "/tmp/test-kit.sock");
          const error = await rejectionOf(fetch("https://example.com/", init));
          expect(error).toBeInstanceOf(NetworkAccessError);
          expect(error).toHaveProperty("host", "example.com");
          expect(reached).toEqual([]);
        } finally {
          uninstall?.();
          uninstall = undefined;
          Reflect.set(globalThis, "fetch", original);
        }
      },
    );

    test("an undefined unix option is not a Unix socket", async () => {
      uninstall = installNetworkGuard({ environment: {} });
      // Built at run time: the typed init does not admit an undefined unix.
      const init: RequestInit = {};
      Reflect.set(init, "unix", undefined);
      const error = await rejectionOf(fetch("http://example.com/", init));
      expect(error).toBeInstanceOf(NetworkAccessError);
    });

    test("manual redirects are left to the caller", async () => {
      uninstall = installNetworkGuard({ environment: {} });
      const server = await serveRedirects();
      const response = await fetch(
        `http://127.0.0.1:${String(server.port)}/away`,
        {
          redirect: "manual",
        },
      );
      expect(response.status).toBe(302);
    });
  });

  test("a remote proxy in the environment refuses the install", () => {
    for (const environment of [
      { HTTPS_PROXY: "http://proxy.example:3128" },
      { http_proxy: "http://proxy.example:3128" },
      { ALL_PROXY: "not a url" },
    ]) {
      expect(() => installNetworkGuard({ environment })).toThrow(
        NetworkAccessError,
      );
    }
    // A loopback proxy keeps every connection on this machine.
    uninstall = installNetworkGuard({
      environment: { HTTP_PROXY: "http://127.0.0.1:3128" },
    });
  });

  test("fetch.preconnect is refused for a remote host before it connects", () => {
    const realFetch = globalThis.fetch;
    const preconnected: string[] = [];
    const fake = Object.assign(async () => new Response("unused"), {
      preconnect: (target: string | URL) => {
        preconnected.push(String(target));
      },
    });
    Reflect.set(globalThis, "fetch", fake);
    try {
      uninstall = installNetworkGuard({ environment: {} });
      const preconnect: unknown = Reflect.get(fetch, "preconnect");
      if (typeof preconnect !== "function") {
        throw new Error("Missing guarded fetch.preconnect");
      }
      expect(() => preconnect("https://example.com/")).toThrow(
        NetworkAccessError,
      );
      preconnect("http://127.0.0.1:1/");
      expect(preconnected).toEqual(["http://127.0.0.1:1/"]);
    } finally {
      uninstall?.();
      uninstall = undefined;
      Reflect.set(globalThis, "fetch", realFetch);
    }
  });

  test("data and blob URLs are not network access", async () => {
    uninstall = installNetworkGuard({ environment: {} });
    const response = await fetch("data:text/plain,hello");
    expect(await response.text()).toBe("hello");
  });

  test("node:net and node:tls sockets to a remote host throw", () => {
    uninstall = installNetworkGuard({ environment: {} });
    expect(() => net.createConnection(5432, "203.0.113.7")).toThrow(
      NetworkAccessError,
    );
    expect(() => tls.connect({ host: "example.com", port: 443 })).toThrow(
      NetworkAccessError,
    );
    // The (port, options) overload carries the host in the second argument.
    expect(() => tls.connect(443, { host: "example.com" })).toThrow(
      NetworkAccessError,
    );
    expect(() => net.connect({ host: "203.0.113.7", port: 5432 })).toThrow(
      NetworkAccessError,
    );
    expect(() => new net.Socket().connect(443, "example.com")).toThrow(
      NetworkAccessError,
    );
  });

  test("HTTP imported before installation refuses a remote request without waiting for a connection", async () => {
    uninstall = installNetworkGuard({ environment: {} });
    const error = await new Promise<unknown>((resolve) => {
      try {
        const request = http.get("http://203.0.113.7:443/", { agent: false });
        request.once("error", resolve);
        // A broken guard must not leave an outbound request running or wait for its timeout.
        request.destroy();
        setImmediate(() => resolve(undefined));
      } catch (caught) {
        resolve(caught);
      }
    });
    expect(error).toBeInstanceOf(NetworkAccessError);
  });

  test("HTTP imported before installation can still reach an explicit loopback host", async () => {
    uninstall = installNetworkGuard({ environment: {} });
    const server = await startServer((_request, response) =>
      response.end("local HTTP"),
    );
    const body = await new Promise<string>((resolve, reject) => {
      const request = http.get(
        `http://127.0.0.1:${server.port}/`,
        { agent: false },
        (response) => {
          const chunks: string[] = [];
          response.setEncoding("utf8");
          response.on("data", (chunk: unknown) => {
            if (typeof chunk !== "string") {
              reject(new Error("HTTP fixture expected decoded text"));
              response.destroy();
              return;
            }
            chunks.push(chunk);
          });
          response.once("end", () => resolve(chunks.join("")));
          response.once("error", reject);
        },
      );
      request.once("error", reject);
    });
    expect(body).toBe("local HTTP");
  });

  test("normalized socket arguments retain their remote host refusal", () => {
    uninstall = installNetworkGuard({ environment: {} });
    const socket = new net.Socket();
    socket.once("error", () => undefined);
    try {
      expect(() =>
        Reflect.apply(socket.connect, socket, [
          [{ host: "203.0.113.7", port: 443 }],
        ]),
      ).toThrow(NetworkAccessError);
    } finally {
      socket.destroy();
    }
  });

  const circularSocketArguments: unknown[] = [];
  circularSocketArguments.push(circularSocketArguments);
  test.each([
    { name: "no arguments", args: [] },
    { name: "empty options", args: [{}] },
    { name: "port only", args: [1234] },
    { name: "empty IPC path", args: [{ path: "" }] },
    { name: "empty positional IPC path", args: [""] },
    { name: "nested empty normalized arguments", args: [[[]]] },
    { name: "circular normalized arguments", args: [circularSocketArguments] },
  ])("undetermined socket targets fail closed: $name", async ({ args }) => {
    uninstall = installNetworkGuard({ environment: {} });
    const socket = new net.Socket();
    socket.once("error", () => undefined);
    try {
      const error = await rejectionOf(
        Promise.resolve().then(() => {
          Reflect.apply(socket.connect, socket, args);
        }),
      );
      expect(error).toBeInstanceOf(NetworkAccessError);
      expect(error).toHaveProperty("host", "(undetermined socket target)");
    } finally {
      socket.destroy();
    }
  });

  test("explicit IPC paths pass through without opening a real socket", () => {
    const socket = new net.Socket();
    const original = spyOn(net.Socket.prototype, "connect").mockImplementation(
      () => socket,
    );
    try {
      uninstall = installNetworkGuard({ environment: {} });
      for (const args of [
        ["/tmp/test-kit-fixture.sock"],
        [{ path: "/tmp/test-kit-fixture.sock" }],
        [[{ path: "/tmp/test-kit-fixture.sock" }]],
      ]) {
        expect(Reflect.apply(socket.connect, socket, args)).toBe(socket);
      }
      expect(original).toHaveBeenCalledTimes(3);
    } finally {
      uninstall?.();
      uninstall = undefined;
      original.mockRestore();
      socket.destroy();
    }
  });

  test.skipIf(typeof Bun === "undefined")(
    "Bun.connect to a remote host rejects",
    async () => {
      uninstall = installNetworkGuard({ environment: {} });
      const error = await rejectionOf(
        Bun.connect({
          hostname: "example.com",
          port: 443,
          socket: { data: () => undefined },
        }),
      );
      expect(error).toBeInstanceOf(NetworkAccessError);
    },
  );

  test.skipIf(typeof Bun !== "undefined")(
    "socket named exports follow installation and restore original identities",
    () => {
      const originalNet = net;
      const originalTls = tls;
      const originalConnect = connectNet;
      const originalCreateConnection = createNetConnection;
      const originalTlsConnect = connectTls;
      uninstall = installNetworkGuard({ environment: {} });
      try {
        expect(net).toBe(originalNet);
        expect(tls).toBe(originalTls);
        expect(connectNet).toBe(net.connect);
        expect(createNetConnection).toBe(net.createConnection);
        expect(connectTls).toBe(tls.connect);
        expect(connectNet).not.toBe(originalConnect);
        expect(createNetConnection).not.toBe(originalCreateConnection);
        expect(connectTls).not.toBe(originalTlsConnect);
      } finally {
        uninstall();
        uninstall = undefined;
      }
      expect(net).toBe(originalNet);
      expect(tls).toBe(originalTls);
      expect(connectNet).toBe(originalConnect);
      expect(createNetConnection).toBe(originalCreateConnection);
      expect(connectTls).toBe(originalTlsConnect);
    },
  );

  test.skipIf(typeof Bun !== "undefined")(
    "named socket factories reject remote hosts on Node",
    () => {
      uninstall = installNetworkGuard({ environment: {} });
      expect(() => connectNet({ host: "203.0.113.7", port: 5432 })).toThrow(
        NetworkAccessError,
      );
      expect(() =>
        createNetConnection({ host: "203.0.113.7", port: 5432 }),
      ).toThrow(NetworkAccessError);
      expect(() => connectTls({ host: "example.com", port: 443 })).toThrow(
        NetworkAccessError,
      );
    },
  );

  test("a stale uninstall cannot remove a later guard", async () => {
    const first = installNetworkGuard({ environment: {} });
    first();
    uninstall = installNetworkGuard({ environment: {} });
    first();
    first();
    const error = await rejectionOf(fetch("https://example.com/"));
    expect(error).toBeInstanceOf(NetworkAccessError);
  });

  test("uninstall restores the originals and a second install panics", () => {
    const originalFetch = globalThis.fetch;
    const originalConnect: unknown = Reflect.get(
      net.Socket.prototype,
      "connect",
    );
    const originalNetConnect = net.connect;
    const remove = installNetworkGuard({ environment: {} });
    expect(() => installNetworkGuard({ environment: {} })).toThrow(
      "already installed",
    );
    remove();
    expect(globalThis.fetch).toBe(originalFetch);
    const restoredConnect: unknown = Reflect.get(
      net.Socket.prototype,
      "connect",
    );
    expect(restoredConnect).toBe(originalConnect);
    expect(net.connect).toBe(originalNetConnect);
  });
});
