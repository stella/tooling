import { useState } from "react";

export const useCounter = (enabled: boolean) => {
  if (enabled) {
    return useState(0);
  }
  return undefined;
};
