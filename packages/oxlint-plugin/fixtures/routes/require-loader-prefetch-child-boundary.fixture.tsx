// The bounded child scan skips nondash imports and unreadable dash imports.

import { createFileRoute } from "@tanstack/react-router";

import { MissingChild } from "@/routes/-components/missing";
import { NonDashChild } from "@/routes/components/card";

const BoundaryComponent = () => (
  <>
    <NonDashChild />
    <MissingChild />
  </>
);

export const Route = createFileRoute("/__fixture/child-boundary")({
  component: BoundaryComponent,
});
