import { withFakeServer } from "@stll/test-kit";
// oxlint-disable-next-line no-real-network-in-tests/no-real-network-in-tests -- fixture
void fetch("https://example.com/data");
// oxlint-disable-next-line no-real-network-in-tests/no-real-network-in-tests -- fixture
void fetch(`https://api.example.com/items`);
// oxlint-disable-next-line no-real-network-in-tests/no-real-network-in-tests -- fixture
new WebSocket("wss://example.com/socket");
// oxlint-disable-next-line no-real-network-in-tests/no-real-network-in-tests -- fixture
new EventSource("https://example.com/events");
// expect-clean: no-real-network-in-tests/no-real-network-in-tests
void fetch("http://localhost:3000/data");
// expect-clean: no-real-network-in-tests/no-real-network-in-tests
void fetch("http://127.0.0.1/data");
// expect-clean: no-real-network-in-tests/no-real-network-in-tests
new WebSocket("ws://[::1]/socket");
// expect-clean: no-real-network-in-tests/no-real-network-in-tests
void withFakeServer(() => fetch("/data"));
