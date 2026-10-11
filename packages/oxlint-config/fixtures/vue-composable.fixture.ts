import { useId } from "vue";

// Vue composables may conditionally call Vue APIs during setup.
export const useOptionalId = (enabled: boolean) => {
  if (enabled) {
    return useId();
  }
  return undefined;
};
