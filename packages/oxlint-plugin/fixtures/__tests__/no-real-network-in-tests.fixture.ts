import { withFakeServer } from "@stll/test-kit";

const externalUrl = "https://static.example.com/data";
const loopbackUrl = `http://localhost:3000/data`;
const host = "localhost";
// oxlint-disable-next-line no-real-network-in-tests/no-real-network-in-tests -- fixture
void fetch("https://example.com/data");
// oxlint-disable-next-line no-real-network-in-tests/no-real-network-in-tests -- fixture
void globalThis.fetch("https://example.com/data");
// oxlint-disable-next-line no-real-network-in-tests/no-real-network-in-tests -- fixture
void fetch(`https://api.example.com/items`);
// oxlint-disable-next-line no-real-network-in-tests/no-real-network-in-tests -- fixture
void fetch(externalUrl);
// oxlint-disable-next-line no-real-network-in-tests/no-real-network-in-tests -- fixture
void fetch(new URL("https://url.example.com/data"));
// oxlint-disable-next-line no-real-network-in-tests/no-real-network-in-tests -- fixture
new WebSocket("wss://example.com/socket");
// oxlint-disable-next-line no-real-network-in-tests/no-real-network-in-tests -- fixture
new EventSource("https://example.com/events");
// expect-clean: no-real-network-in-tests/no-real-network-in-tests
void fetch("http://localhost:3000/data");
// expect-clean: no-real-network-in-tests/no-real-network-in-tests
void fetch("http://127.0.0.1/data");
// expect-clean: no-real-network-in-tests/no-real-network-in-tests
void fetch("http://127.10.0.3");
// expect-clean: no-real-network-in-tests/no-real-network-in-tests
void fetch("http://[::1]:8080");
// expect-clean: no-real-network-in-tests/no-real-network-in-tests
void fetch(`http://${host}/`);
// expect-clean: no-real-network-in-tests/no-real-network-in-tests
void fetch(`http://${anything}/`);
// oxlint-disable-next-line no-real-network-in-tests/no-real-network-in-tests -- fixture
void fetch(`https://${"api.example.com"}/`);
// expect-clean: no-real-network-in-tests/no-real-network-in-tests
void fetch("data:text/plain,fixture");
// expect-clean: no-real-network-in-tests/no-real-network-in-tests
void fetch("blob:https://example.com/fixture-id");
// expect-clean: no-real-network-in-tests/no-real-network-in-tests
void fetch("file:///tmp/fixture");
// expect-clean: no-real-network-in-tests/no-real-network-in-tests
void fetch(loopbackUrl);
// expect-clean: no-real-network-in-tests/no-real-network-in-tests
const _fetchTarget = (target: string) => fetch(target);
// expect-clean: no-real-network-in-tests/no-real-network-in-tests
new WebSocket("ws://[::1]/socket");
// expect-clean: no-real-network-in-tests/no-real-network-in-tests
void withFakeServer(() => fetch("/data"));

{
  const fetch = (_url: string) => Promise.resolve(new Response());
  // expect-clean: no-real-network-in-tests/no-real-network-in-tests
  void fetch("https://example.com/data");
}

const cyclicUrlA = cyclicUrlB;
const cyclicUrlB = cyclicUrlA;
// expect-clean: no-real-network-in-tests/no-real-network-in-tests
void fetch(cyclicUrlA);
const selfUrl = selfUrl;
// expect-clean: no-real-network-in-tests/no-real-network-in-tests
void fetch(selfUrl);
const scopedExternalUrl = "https://scoped.example.com/data";
const requestScopedUrl = () => {
  // oxlint-disable-next-line no-real-network-in-tests/no-real-network-in-tests -- fixture
  void fetch(scopedExternalUrl);
};
void requestScopedUrl;
