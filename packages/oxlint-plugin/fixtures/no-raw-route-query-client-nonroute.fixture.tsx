// Route query restrictions do not apply to ordinary component behavior.

import { useQuery, useQueryClient } from "@tanstack/react-query";

declare const options: { queryKey: readonly ["fixture"] };

export function ClientComponent() {
  const queryClient = useQueryClient();
  queryClient.fetchQuery(options);
  return useQuery(options).data;
}
