import type { Ref } from "vue";

// Vue composables may mutate caller-owned refs.
export const useCounter = (count: Ref<number>) => {
  count.value += 1;
  return count.value;
};
