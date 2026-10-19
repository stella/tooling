import { fetch } from "../fake-fetch";

// expect-clean: no-real-network-in-tests/no-real-network-in-tests
void fetch("https://example.com/data");
